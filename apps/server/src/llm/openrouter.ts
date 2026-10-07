import { apiKey } from "../lib/config.js";
import { parts, type RawJsonCall } from "./types.js";

type Mode = "tool" | "json_schema";

// Some models (e.g. Claude with always-on thinking) reject forced tool_choice; remember which.
const modeFor = new Map<string, Mode>();

/**
 * OpenAI-compatible chat completions. Structured output via a single forced tool call, falling
 * back to `response_format: json_schema` for models that refuse a forced tool choice.
 */
export const openrouterJson: RawJsonCall = async (req, jsonSchema, model) => {
  const mode = modeFor.get(model) ?? "tool";
  try {
    return await callOnce(req, jsonSchema, model, mode);
  } catch (err) {
    if (mode === "tool" && /tool_choice|tool choice|tool use|tools? (are|is) not supported/i.test(String(err))) {
      modeFor.set(model, "json_schema");
      return callOnce(req, jsonSchema, model, "json_schema");
    }
    throw err;
  }
};

const callOnce = async (req: Parameters<RawJsonCall>[0], jsonSchema: object, model: string, mode: Mode) => {
  const system =
    mode === "tool"
      ? req.system
      : `${req.system}\n\nRespond with ONLY a JSON object (no prose, no code fences) matching this JSON schema:\n${JSON.stringify(jsonSchema)}`;
  const messages = [
    { role: "system", content: system },
    ...req.messages.map((m) => ({
      role: m.role,
      content: parts(m.content).map((p) =>
        p.type === "text"
          ? { type: "text", text: p.text }
          : { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.data.toString("base64")}` } },
      ),
    })),
  ];
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey("openrouter")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      ...(mode === "tool"
        ? {
            tools: [{ type: "function", function: { name: req.name, description: req.description, parameters: jsonSchema } }],
            tool_choice: { type: "function", function: { name: req.name } },
          }
        : { response_format: { type: "json_schema", json_schema: { name: req.name, strict: false, schema: jsonSchema } } }),
      max_tokens: 16000,
      usage: { include: true },
    }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 500)}`);
  const cost = typeof body.usage?.cost === "number" ? body.usage.cost : null;
  const msg = body.choices?.[0]?.message;
  const args = msg?.tool_calls?.[0]?.function?.arguments;
  if (args) return { value: JSON.parse(args), cost };
  // Some models ignore tool_choice and answer in text; accept a JSON body there.
  const text: string = msg?.content ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (match) return { value: JSON.parse(match[0]), cost };
  throw new Error(`OpenRouter returned no tool call: ${JSON.stringify(msg).slice(0, 300)}`);
};
