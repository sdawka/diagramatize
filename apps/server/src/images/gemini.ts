import { apiKey } from "../lib/config.js";
import { fanOut, type ImageProvider } from "./types.js";

/** Gemini native image generation (Nano Banana family) via generateContent. */
export const geminiImages: ImageProvider = (req) =>
  fanOut(req.n ?? 1, async () => {
    const parts: object[] = (req.references ?? []).map((buf) => ({
      inlineData: { mimeType: "image/png", data: buf.toString("base64") },
    }));
    parts.push({ text: req.prompt });
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": apiKey("gemini"), "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          ...(req.aspectRatio ? { imageConfig: { aspectRatio: req.aspectRatio } } : {}),
        },
      }),
    });
    const json = (await res.json()) as any;
    if (!res.ok) throw new Error(`Gemini images ${res.status}: ${JSON.stringify(json.error ?? json).slice(0, 500)}`);
    const out = (json.candidates?.[0]?.content?.parts ?? [])
      .filter((p: any) => p.inlineData?.data)
      .map((p: any) => ({ data: Buffer.from(p.inlineData.data, "base64"), mediaType: p.inlineData.mimeType }));
    return out;
  });
