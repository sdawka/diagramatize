import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { SplitMode, type Project } from "@diagram/core";
import { config, KEY_HEADERS, keySource, keysFromHeaders, scrub, withRequestKeys, type ProviderName } from "./lib/config.js";
import { catalog } from "./images/catalog.js";
import { createProject, events, list, load, readAsset, update } from "./lib/store.js";
import { appendLog, readLog } from "./lib/log.js";
import { withStage } from "./lib/usage.js";
import * as stages from "./pipeline/stages.js";

const app = new Hono();

app.onError((err, c) => {
  const msg = scrub(err.message);
  console.error(scrub(String(err.stack ?? err)));
  return c.json({ error: msg }, 400);
});

// BYOK: keys arrive only as request headers (never query strings) and are scoped to this request
// and any background job it starts via AsyncLocalStorage. They are never persisted or logged.
app.use("/api/*", (c, next) => withRequestKeys(keysFromHeaders((n) => c.req.header(n)), next));

// Record every user decision (answers, feedback, approvals, picks, box edits, build options…).
app.use("/api/projects/:id/*", async (c, next) => {
  if (c.req.method === "POST" || c.req.method === "PUT") {
    const id = c.req.param("id");
    const body = c.req.path.endsWith("/workspace") ? "[workspace snapshot]" : await c.req.json().catch(() => null);
    await appendLog(id, { type: "action", method: c.req.method, path: c.req.path.replace(`/api/projects/${id}`, ""), body });
  }
  await next();
});

app.get("/api/projects/:id/log", async (c) => c.json(await readLog(c.req.param("id"))));

app.get("/api/config", (c) =>
  c.json({
    llmProvider: config.llmProvider,
    llmModel: config.llmModel,
    synthesisModel: config.synthesisModel,
    imageProvider: config.imageProvider,
    candidateModel: config.candidateModel,
    regenModel: config.regenModel,
    vectorModel: config.vectorModel,
    draftModel: config.draftModel,
    layerModel: config.layerModel,
    keys: Object.fromEntries((Object.keys(KEY_HEADERS) as Exclude<ProviderName, "mock">[]).map((p) => [p, keySource(p)])),
  }),
);

const TEST_URLS: Record<string, { url: string; headers: (k: string) => Record<string, string> }> = {
  openrouter: { url: "https://openrouter.ai/api/v1/key", headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  anthropic: { url: "https://api.anthropic.com/v1/models?limit=1", headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }) },
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: (k) => ({ "x-goog-api-key": k }) },
  openai: { url: "https://api.openai.com/v1/models", headers: (k) => ({ Authorization: `Bearer ${k}` }) },
};

/** Validate the key sent for `provider` with a cheap read-only call. Returns only ok/message, never the key. */
app.post("/api/keys/test", async (c) => {
  const { provider } = await c.req.json<{ provider: string }>().catch(() => ({ provider: "" }));
  const spec = TEST_URLS[provider];
  if (!spec) return c.json({ ok: false, message: "Unknown provider" }, 400);
  const key = keysFromHeaders((n) => c.req.header(n))[provider as Exclude<ProviderName, "mock">];
  if (!key) return c.json({ ok: false, message: "No key sent" });
  try {
    const res = await fetch(spec.url, { headers: spec.headers(key), signal: AbortSignal.timeout(10000) });
    if (res.ok) return c.json({ ok: true, message: "Key accepted" });
    return c.json({ ok: false, message: res.status === 401 || res.status === 403 ? "Key rejected by the provider" : `Provider returned ${res.status}` });
  } catch (err) {
    return c.json({ ok: false, message: scrub(`Could not reach the provider: ${(err as Error).message}`) });
  }
});

app.get("/api/image-models", async (c) => c.json(config.imageProvider === "openrouter" ? await catalog() : []));

app.get("/api/projects", async (c) => c.json(await list()));

app.post("/api/projects", async (c) => {
  const { topic, stylePreset, styleNotes } = await c.req.json<{ topic: string; stylePreset?: string; styleNotes?: string }>();
  if (!topic?.trim()) throw new Error("topic is required");
  const p = await createProject(topic.trim(), { stylePreset, styleNotes });
  await appendLog(p.id, { type: "action", method: "POST", path: "/", body: { topic, stylePreset, styleNotes } });
  await stages.runJob(p.id, "clarify", () => stages.clarify(p.id));
  return c.json(p);
});

app.get("/api/projects/:id", async (c) => c.json(await load(c.req.param("id"))));

/** Streams the full project snapshot on every save. */
app.get("/api/projects/:id/events", (c) => {
  const id = c.req.param("id");
  return streamSSE(c, async (stream) => {
    const send = (p: Project) => stream.writeSSE({ event: "project", data: JSON.stringify(p) });
    await send(await load(id));
    const listener = (p: Project) => void send(p);
    events.on(`project:${id}`, listener);
    const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 20000);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(ping);
    events.off(`project:${id}`, listener);
  });
});

/** Re-run the first-principles analysis (e.g. after the first call failed). */
app.post("/api/projects/:id/clarify", async (c) => {
  const id = c.req.param("id");
  await stages.runJob(id, "clarify", () => stages.clarify(id));
  return c.json({ ok: true });
});

app.post("/api/projects/:id/answers", async (c) => {
  const id = c.req.param("id");
  const { answers } = await c.req.json<{ answers: Record<string, string> }>();
  await stages.runJob(id, "clarify", () => stages.answer(id, answers));
  return c.json({ ok: true });
});

app.post("/api/projects/:id/concept", async (c) => {
  const id = c.req.param("id");
  const { feedback } = await c.req.json<{ feedback?: string }>().catch(() => ({ feedback: undefined }));
  await stages.runJob(id, "concept", () => stages.concept(id, feedback));
  return c.json({ ok: true });
});

/** Change the visual style; applies to the next concept revision, image generation or component rebuild. */
app.put("/api/projects/:id/style", async (c) => {
  const { stylePreset, styleNotes } = await c.req.json<{ stylePreset?: string; styleNotes?: string }>();
  return c.json(
    await update(c.req.param("id"), (p) => {
      if (stylePreset !== undefined) p.stylePreset = stylePreset;
      if (styleNotes !== undefined) p.styleNotes = styleNotes;
    }),
  );
});

app.post("/api/projects/:id/concept/approve", async (c) => {
  const id = c.req.param("id");
  await stages.approveConcept(id);
  await stages.runJob(id, "composition", (progress) => stages.composeAndDraw(id, undefined, progress));
  return c.json({ ok: true });
});

/** Propose (or re-propose with feedback) composition options. */
app.post("/api/projects/:id/compositions", async (c) => {
  const id = c.req.param("id");
  const { feedback } = await c.req.json<{ feedback?: string }>().catch(() => ({ feedback: undefined }));
  await stages.runJob(id, "composition", (progress) => stages.composeAndDraw(id, feedback, progress));
  return c.json({ ok: true });
});

/** Redraw one composition's whole-figure draft, optionally with the user's comments on it. */
app.post("/api/projects/:id/compositions/:cid/draft", async (c) => {
  const id = c.req.param("id");
  const cid = c.req.param("cid");
  const { feedback } = await c.req.json<{ feedback?: string }>().catch(() => ({ feedback: undefined }));
  await stages.runJob(id, "draft", (progress) =>
    progress(feedback ? "Redrawing the draft with your changes…" : "Redrawing the draft…").then(() => stages.drawComposition(id, cid, feedback)),
  );
  return c.json({ ok: true });
});

/** Re-sketch element prototypes (all stale ones, or specific nodes with optional notes). */
app.post("/api/projects/:id/prototypes", async (c) => {
  const id = c.req.param("id");
  const opts = await c.req.json<{ nodeIds?: string[]; feedback?: string }>().catch(() => ({}));
  await stages.runJob(id, "prototypes", (progress) => stages.prototypes(id, opts, progress));
  return c.json({ ok: true });
});

/** Choose a composition (with any manual adjustments) and move on to images. */
app.put("/api/projects/:id/composition", async (c) => {
  const { composition } = await c.req.json<{ composition: unknown }>();
  return c.json(await stages.chooseComposition(c.req.param("id"), composition));
});

app.post("/api/projects/:id/candidates", async (c) => {
  const id = c.req.param("id");
  const opts = await c.req.json<stages.CandidateOptions>().catch(() => ({}));
  await stages.runJob(id, "candidates", (progress) => stages.candidates(id, opts, progress));
  return c.json({ ok: true });
});

app.post("/api/projects/:id/pick", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ candidateId: string; split?: string }>();
  const { candidateId } = body;
  const split = SplitMode.parse(body.split ?? "whole");
  await stages.runJob(id, "decompose", (progress) => stages.pick(id, candidateId, split, progress));
  return c.json({ ok: true });
});

app.put("/api/projects/:id/components", async (c) => {
  const { components } = await c.req.json();
  return c.json(await stages.editComponents(c.req.param("id"), components));
});

app.post("/api/projects/:id/build", async (c) => {
  const id = c.req.param("id");
  const opts = await c.req.json<stages.BuildOptions>();
  await stages.runJob(id, "build", (progress) => stages.build(id, opts, progress));
  return c.json({ ok: true });
});

app.post("/api/projects/:id/components/:cid/rebuild", async (c) => {
  const id = c.req.param("id");
  const opts = await c.req.json<stages.BuildOptions>();
  return c.json(await withStage(id, "rebuild", () => stages.rebuildComponent(id, c.req.param("cid"), opts)));
});

app.post("/api/projects/:id/layout", async (c) => {
  const { mode } = await c.req.json<{ mode: "original" | "auto" }>();
  return c.json(await stages.relayout(c.req.param("id"), mode));
});

app.put("/api/projects/:id/workspace", async (c) => {
  const { workspace } = await c.req.json();
  await stages.saveWorkspace(c.req.param("id"), workspace);
  return c.json({ ok: true });
});

const TYPES: Record<string, string> = { png: "image/png", svg: "image/svg+xml", webp: "image/webp", jpg: "image/jpeg" };

app.get("/files/:id/*", async (c) => {
  const id = c.req.param("id");
  const rel = decodeURIComponent(c.req.path.slice(`/files/${id}/`.length));
  const data = await readAsset(id, rel).catch(() => null);
  if (!data) return c.notFound();
  const ext = rel.split(".").pop() ?? "";
  return c.body(new Uint8Array(data), 200, {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
  });
});

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`diagram server on http://localhost:${config.port}`);
  console.log(`  LLM: ${config.llmProvider} (${config.llmModel}; synthesis ${config.synthesisModel})  images: ${config.imageProvider} (${config.candidateModel})`);
});
