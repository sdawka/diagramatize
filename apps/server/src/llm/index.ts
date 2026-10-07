import { z } from "zod";
import { config, scrub, scrubError } from "../lib/config.js";
import { logStage, loggableMessages } from "../lib/log.js";
import { recordUsage } from "../lib/usage.js";
import { anthropicJson } from "./anthropic.js";
import { geminiJson } from "./gemini.js";
import { mockJson } from "./mock.js";
import { openrouterJson } from "./openrouter.js";
import type { JsonRequest, RawJsonCall } from "./types.js";

export type { Msg, Part } from "./types.js";

export function toJsonSchema(schema: z.ZodType): object {
  const { $schema, ...rest } = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  return rest;
}

const PROVIDERS: Record<string, RawJsonCall> = {
  openrouter: openrouterJson,
  anthropic: anthropicJson,
  gemini: geminiJson,
  mock: mockJson,
};

/** Ask the configured LLM for JSON matching `schema`; retries once with the validation error. */
export async function llmJson<T>(req: JsonRequest<T>): Promise<T> {
  const call = PROVIDERS[config.llmProvider];
  if (!call) throw new Error(`Unsupported LLM provider: ${config.llmProvider}`);
  const jsonSchema = toJsonSchema(req.schema);
  let messages = req.messages;
  const model = config.llmModelFor(req.name, req.tier);
  const logBase = { type: "llm" as const, name: req.name, model, system: req.system };
  for (let attempt = 0; ; attempt++) {
    const t0 = performance.now();
    let raw: unknown;
    try {
      const out = await call({ ...req, messages } as JsonRequest<unknown>, jsonSchema, model);
      raw = out.value;
      const ms = Math.round(performance.now() - t0);
      await recordUsage({ kind: "llm", provider: config.llmProvider, model, ms, cost: out.cost });
      await logStage({ ...logBase, attempt, messages: loggableMessages(messages), response: raw, ms, cost: out.cost });
    } catch (err) {
      const ms = Math.round(performance.now() - t0);
      await recordUsage({ kind: "llm", provider: config.llmProvider, model, ms, cost: null, ok: false });
      await logStage({ ...logBase, attempt, messages: loggableMessages(messages), error: scrub(String(err)), ms, cost: null });
      throw scrubError(err);
    }
    const parsed = req.schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    if (attempt >= 1) throw new Error(`LLM output failed validation: ${parsed.error.message}`);
    messages = [
      ...messages,
      { role: "assistant", content: JSON.stringify(raw) },
      { role: "user", content: `That output did not match the schema:\n${parsed.error.message}\nReturn corrected JSON.` },
    ];
  }
}
