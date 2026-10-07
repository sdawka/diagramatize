import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// No provider selection from env: keys decide. Env key is a distinct sentinel.
delete process.env.LLM_PROVIDER;
delete process.env.IMAGE_PROVIDER;
delete process.env.OPENROUTER_API_KEY;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.GEMINI_API_KEY;
delete process.env.OPENAI_API_KEY;
process.env.GEMINI_API_KEY = "env-gemini-key-123456";
process.env.DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "diagram-byok-"));

const { apiKey, config, keysFromHeaders, scrub, withRequestKeys } = await import("../src/lib/config.js");
const store = await import("../src/lib/store.js");
const stages = await import("../src/pipeline/stages.js");

const OR = "sk-or-v1-byok-secret-abcdef123456";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const headers = (h: Record<string, string>) => keysFromHeaders((n) => h[n]);

describe("BYOK request-scoped keys", () => {
  it("header keys override env inside a request, env applies outside", () => {
    expect(apiKey("gemini")).toBe("env-gemini-key-123456");
    expect(config.llmProvider).toBe("gemini");
    withRequestKeys(headers({ "x-openrouter-key": OR, "x-gemini-key": "byok-gemini-key-654321" }), () => {
      expect(apiKey("openrouter")).toBe(OR);
      expect(apiKey("gemini")).toBe("byok-gemini-key-654321");
      expect(config.llmProvider).toBe("openrouter");
      expect(config.imageProvider).toBe("openrouter");
    });
  });

  it("rejects malformed header values", () => {
    expect(headers({ "x-openrouter-key": "has space" })).toEqual({});
    expect(headers({ "x-openrouter-key": "REPLACE_ME" })).toEqual({});
  });

  it("is not visible to another concurrent request", async () => {
    const seen: Record<string, string | undefined> = {};
    const req = (name: string, keys: Record<string, string>, ms: number) =>
      withRequestKeys(headers(keys), async () => {
        await delay(ms);
        seen[name] = apiKey("openrouter");
      });
    const none = withRequestKeys({}, async () => {
      await delay(5);
      try {
        apiKey("openrouter");
        seen.none = "leaked";
      } catch {
        seen.none = undefined;
      }
    });
    await Promise.all([req("a", { "x-openrouter-key": "key-for-request-a" }, 20), req("b", { "x-openrouter-key": "key-for-request-b" }, 5), none]);
    expect(seen).toEqual({ a: "key-for-request-a", b: "key-for-request-b", none: undefined });
  });

  it("is visible inside a fire-and-forget job, and never lands in project.json or the job error", async () => {
    let inJob: string | undefined;
    let providerInJob: string | undefined;
    const p = await store.createProject("byok test", {});
    await withRequestKeys(headers({ "x-openrouter-key": OR }), () =>
      stages.runJob(p.id, "clarify", async () => {
        await delay(30); // request has already returned by now
        inJob = apiKey("openrouter");
        providerInJob = config.llmProvider;
        throw new Error(`provider echoed Authorization: Bearer ${OR}`);
      }),
    );
    // Outside the request context the key is gone.
    expect(() => apiKey("openrouter")).toThrow();
    for (let i = 0; i < 50 && inJob === undefined; i++) await delay(20);
    await delay(100);
    expect(inJob).toBe(OR);
    expect(providerInJob).toBe("openrouter");

    const dir = store.projectDir(p.id);
    for (const f of await fs.readdir(dir)) {
      const st = await fs.stat(path.join(dir, f));
      if (st.isFile()) expect(await fs.readFile(path.join(dir, f), "utf8")).not.toContain(OR);
    }
    const saved = await store.load(p.id);
    expect(saved.job?.status).toBe("error");
    expect(saved.job?.error).toContain("[redacted-key]");
  });

  it("scrubs keys from text", () => {
    withRequestKeys(headers({ "x-openrouter-key": OR }), () => {
      expect(scrub(`boom ${OR} boom`)).toBe("boom [redacted-key] boom");
    });
    expect(scrub("env-gemini-key-123456")).toBe("[redacted-key]");
  });
});
