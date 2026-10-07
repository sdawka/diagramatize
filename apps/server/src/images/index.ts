import { config, scrub, scrubError } from "../lib/config.js";
import { logStage } from "../lib/log.js";
import { recordUsage } from "../lib/usage.js";
import { geminiImages } from "./gemini.js";
import { mockImages } from "./mock.js";
import { openaiImages } from "./openai.js";
import { openrouterImages } from "./openrouter.js";
import type { ImageOut, ImageProvider, ImageRequest } from "./types.js";

export type { ImageOut, ImageRequest } from "./types.js";

const PROVIDERS: Record<string, ImageProvider> = {
  openrouter: openrouterImages,
  gemini: geminiImages,
  openai: openaiImages,
  mock: mockImages,
};

/** Generate images with the configured provider, recording cost + latency on the project. */
export async function generateImages(req: ImageRequest): Promise<ImageOut[]> {
  const provider = PROVIDERS[config.imageProvider];
  if (!provider) throw new Error(`Unsupported image provider: ${config.imageProvider}`);
  const t0 = performance.now();
  const { prompt, model, references, ref, context: _context, ...params } = req;
  const logBase = { type: "image" as const, model, prompt, params, references: references?.length ?? 0, ref };
  let out: ImageOut[];
  try {
    out = await provider(req);
  } catch (err) {
    await recordUsage({
      kind: "image",
      provider: config.imageProvider,
      model: req.model,
      ms: Math.round(performance.now() - t0),
      cost: null,
      ref: req.ref,
      ok: false,
    });
    await logStage({ ...logBase, error: scrub(String(err)), ms: Math.round(performance.now() - t0), cost: null });
    throw scrubError(err);
  }
  if (!out.length) throw new Error("Image provider returned no images");
  const ms = Math.round(performance.now() - t0);
  // One usage event per provider request, however many images it returned.
  const calls = new Map<number, ImageOut[]>();
  out.forEach((o, i) => {
    o.ms ??= ms;
    o.cost ??= config.imageProvider === "mock" ? 0 : null;
    const k = o.call ?? -1 - i;
    calls.set(k, [...(calls.get(k) ?? []), o]);
  });
  for (const outs of calls.values()) {
    const known = outs.filter((o) => o.cost != null);
    const cost = known.length ? known.reduce((s, o) => s + o.cost!, 0) : null;
    await logStage({ ...logBase, outputs: outs.length, ms: outs[0].ms!, cost });
    await recordUsage({
      kind: "image",
      provider: config.imageProvider,
      model: req.model,
      ms: outs[0].ms!,
      cost,
      ref: req.ref,
    });
  }
  return out;
}
