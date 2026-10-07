// Drive the full pipeline over HTTP against a running server (pnpm dev).
// Usage: node scripts/e2e.mjs "<topic>" [--model m] [--style preset] [--split whole|layers|boxes] [--mode trace|regenerate]
//        [--project <id>] (resume at the image stage) [--regen-one]
const args = process.argv.slice(2);
const topic = args[0] ?? "How a TCP three-way handshake works";
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const BASE = opt("--base", "http://localhost:8790");
const imageModel = opt("--model", "google/gemini-nano-banana-2.1");
const style = opt("--style", "flat");
const split = opt("--split", "whole");
const mode = opt("--mode", "trace");

const j = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json)}`);
  return json;
};

const t0 = Date.now();
const log = (...m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

/** Poll until the current job finishes. */
async function settle(id) {
  for (;;) {
    const p = await j("GET", `/api/projects/${id}`);
    if (p.job?.status === "error") throw new Error(`job ${p.job.kind} failed: ${p.job.error}`);
    if (!p.job || p.job.status === "done") return p;
    await new Promise((r) => setTimeout(r, 1500));
  }
}

let p;
const resume = opt("--project", null);
if (resume) {
  p = await settle(resume);
  log("resuming", p.id, p.topic);
} else {
  p = await j("POST", "/api/projects", { topic, stylePreset: style });
  log("project", p.id, topic);
  p = await settle(p.id);
  const round = p.clarify.at(-1);
  log("analysis:", round.analysis.coreIdea, "|", round.analysis.recommendedDiagram);
  for (const q of round.questions) log("  Q:", q.question, "→", q.options[0]);

  if (round.questions.length) {
    await j("POST", `/api/projects/${p.id}/answers`, { answers: Object.fromEntries(round.questions.map((q) => [q.id, q.options[0]])) });
    p = await settle(p.id);
  }
  while (!p.concept) {
    // A second clarify round may have been asked.
    const r = p.clarify.at(-1);
    await j("POST", `/api/projects/${p.id}/answers`, { answers: Object.fromEntries(r.questions.map((q) => [q.id, q.options[0]])) });
    p = await settle(p.id);
  }
  log("main point:", p.concept.mainPoint);
  log("concept:", p.concept.title, `(${p.concept.nodes.length} nodes, ${p.concept.edges.length} edges, ${p.concept.layoutIntent})`);
  log("  nodes:", p.concept.nodes.map((n) => n.label).join(", "));
}

if (!p.composition) {
  await j("POST", `/api/projects/${p.id}/concept/approve`);
  p = await settle(p.id);
  for (const c of p.compositions) log("composition:", c.name, c.aspectRatio, "focal:", c.items.filter((i) => i.emphasis === "focal").map((i) => i.nodeRef).join(","));
  log("sketches:", Object.keys(p.prototypes).length);
  await j("PUT", `/api/projects/${p.id}/composition`, { composition: p.compositions[0] });
}
await j("POST", `/api/projects/${p.id}/candidates`, { models: [imageModel], n: 1 });
p = await settle(p.id);
for (const c of p.candidates) log("candidate", c.id, c.model, `${c.ms}ms`, c.cost);

await j("POST", `/api/projects/${p.id}/pick`, { candidateId: p.candidates[0].id, split });
p = await settle(p.id);
for (const c of p.components) log("component", c.id, c.role, c.source, JSON.stringify(c.bbox, (_, v) => (typeof v === "number" ? +v.toFixed(3) : v)));

await j("POST", `/api/projects/${p.id}/build`, { regenerate: mode === "regenerate" });
p = await settle(p.id);
for (const c of p.components) log("built", c.id, c.status, c.svg ?? c.error);
log("scene:", p.scene.nodes.length, "nodes,", p.scene.edges.length, "edges", `${p.scene.width}x${p.scene.height}`);

if (args.includes("--regen-one")) {
  const first = p.components.find((c) => c.include);
  const out = await j("POST", `/api/projects/${p.id}/components/${first.id}/rebuild`, { regenerate: true });
  log("regenerated", first.id, "→", out.svg);
  p = await j("GET", `/api/projects/${p.id}`);
}

const total = p.usage.reduce((s, e) => s + (e.cost ?? 0), 0);
log(`usage: ${p.usage.length} calls, $${total.toFixed(4)}`);
for (const e of p.usage) console.log(`   ${e.stage.padEnd(10)} ${e.kind.padEnd(5)} ${e.model.padEnd(42)} ${String(e.ms).padStart(6)}ms ${e.cost ?? "n/a"} ${e.ok ? "" : "FAILED"}`);
console.log(`open http://localhost:5174/#/p/${p.id}`);
