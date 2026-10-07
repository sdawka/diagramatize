import { apiKey } from "../lib/config.js";
import { fitParams, modelCaps } from "./catalog.js";
import { fanOut, type ImageProvider } from "./types.js";

/** OpenRouter Images API: POST /api/v1/images, base64 output, references via `input_references`. */
export const openrouterImages: ImageProvider = async (req) => {
  const caps = await modelCaps(req.model);
  const { params, refs } = fitParams(
    caps,
    {
      aspect_ratio: req.aspectRatio,
      background: req.background,
      quality: req.quality,
      output_format: req.outputFormat,
    },
    req.references?.length ?? 0,
  );
  return fanOut(req.n ?? 1, async () => {
    const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, ...params };
    if (refs > 0) {
      body.input_references = req.references!.slice(0, refs).map((buf) => ({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${buf.toString("base64")}` },
      }));
    }
    const t0 = performance.now();
    const res = await fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey("openrouter")}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`OpenRouter images ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 500)}`);
    const ms = Math.round(performance.now() - t0);
    const data: any[] = json.data ?? [];
    const cost = typeof json.usage?.cost === "number" ? json.usage.cost / Math.max(1, data.length) : null;
    return data.map((d) => ({ data: Buffer.from(d.b64_json, "base64"), mediaType: d.media_type ?? "image/png", ms, cost }));
  });
};
