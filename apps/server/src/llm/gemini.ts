import { apiKey } from "../lib/config.js";
import { parts, type RawJsonCall } from "./types.js";

/** Gemini generateContent in JSON mode with a response schema. */
export const geminiJson: RawJsonCall = async (req, jsonSchema, model) => {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey("gemini"), "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: req.messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: parts(m.content).map((p) =>
          p.type === "text" ? { text: p.text } : { inlineData: { mimeType: p.mediaType, data: p.data.toString("base64") } },
        ),
      })),
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: jsonSchema },
    }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 500)}`);
  const text = body.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  return { value: JSON.parse(text), cost: null };
};
