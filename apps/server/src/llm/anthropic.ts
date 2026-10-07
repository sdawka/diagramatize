import { apiKey } from "../lib/config.js";
import { parts, type RawJsonCall } from "./types.js";

/** Anthropic Messages API with a forced tool call; the system prompt is cached across stages. */
export const anthropicJson: RawJsonCall = async (req, jsonSchema, model) => {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey("anthropic"),
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 8000,
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: req.messages.map((m) => ({
        role: m.role,
        content: parts(m.content).map((p) =>
          p.type === "text"
            ? { type: "text", text: p.text }
            : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data.toString("base64") } },
        ),
      })),
      tools: [{ name: req.name, description: req.description, input_schema: jsonSchema }],
      tool_choice: { type: "tool", name: req.name },
    }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${JSON.stringify(body.error ?? body).slice(0, 500)}`);
  const block = body.content?.find((b: any) => b.type === "tool_use");
  if (!block) throw new Error("Anthropic returned no tool_use block");
  return { value: block.input, cost: null };
};
