import type { z } from "zod";

export type Part = { type: "text"; text: string } | { type: "image"; data: Buffer; mediaType: string };
export type Msg = { role: "user" | "assistant"; content: string | Part[] };

export interface JsonRequest<T> {
  /** Tool / schema name, also used by the mock provider to pick a canned answer. */
  name: "clarify" | "concept" | "composition" | "decompose" | "layers";
  description: string;
  system: string;
  messages: Msg[];
  schema: z.ZodType<T>;
  /** "synthesis" routes to the stronger reasoning model (first-principles analysis, concept). */
  tier?: "synthesis" | "general";
  /** Structured context only the mock provider reads. */
  context?: unknown;
}

/** Provider call: the raw (unvalidated) JSON the model produced, plus USD cost when reported. */
export type RawJsonCall = (
  req: JsonRequest<unknown>,
  jsonSchema: object,
  model: string,
) => Promise<{ value: unknown; cost: number | null }>;

export const parts = (content: Msg["content"]): Part[] =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;
