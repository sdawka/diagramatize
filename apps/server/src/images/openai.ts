import { apiKey } from "../lib/config.js";
import type { AspectRatio } from "@diagram/core";
import type { ImageProvider } from "./types.js";

const SIZES: Record<AspectRatio, string> = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "16:9": "1536x1024",
  "4:3": "1536x1024",
  "2:3": "1024x1536",
  "3:4": "1024x1536",
  "9:16": "1024x1536",
};

/** Direct OpenAI Images API: generations, or edits when reference images are given. */
export const openaiImages: ImageProvider = async (req) => {
  const size = SIZES[req.aspectRatio ?? "1:1"];
  let res: Response;
  if (req.references?.length) {
    const form = new FormData();
    form.set("model", req.model);
    form.set("prompt", req.prompt);
    form.set("n", String(req.n ?? 1));
    form.set("size", size);
    if (req.background) form.set("background", req.background);
    if (req.quality) form.set("quality", req.quality);
    req.references.forEach((buf, i) => form.append("image[]", new Blob([new Uint8Array(buf)], { type: "image/png" }), `ref${i}.png`));
    res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey("openai")}` },
      body: form,
    });
  } else {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey("openai")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: req.model,
        prompt: req.prompt,
        n: req.n ?? 1,
        size,
        ...(req.background ? { background: req.background } : {}),
        ...(req.quality ? { quality: req.quality } : {}),
      }),
    });
  }
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`OpenAI images ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 500)}`);
  return (json.data ?? []).map((d: any) => ({ data: Buffer.from(d.b64_json, "base64"), mediaType: "image/png" }));
};
