import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ProviderName = "openrouter" | "anthropic" | "gemini" | "openai" | "mock";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

type KeyedProvider = Exclude<ProviderName, "mock">;
export type RequestKeys = Partial<Record<KeyedProvider, string>>;

/** Header carrying each provider's BYOK key. Keys are accepted from headers only. */
export const KEY_HEADERS: Record<KeyedProvider, string> = {
  openrouter: "x-openrouter-key",
  anthropic: "x-anthropic-key",
  gemini: "x-gemini-key",
  openai: "x-openai-key",
};

/** Keys supplied by the client for the current request (and any job it starts); propagates through async continuations. */
const keyStore = new AsyncLocalStorage<RequestKeys>();

function clean(v: string | undefined | null): string | undefined {
  const t = v?.trim();
  // Reject empties, template placeholders, oversized values and anything that isn't printable ASCII.
  if (!t || t.length > 512 || /REPLACE_ME/i.test(t) || !/^[\x21-\x7e]+$/.test(t)) return undefined;
  return t;
}

export function keysFromHeaders(get: (name: string) => string | undefined | null): RequestKeys {
  const out: RequestKeys = {};
  for (const p of Object.keys(KEY_HEADERS) as KeyedProvider[]) {
    const k = clean(get(KEY_HEADERS[p]));
    if (k) out[p] = k;
  }
  return out;
}

export function withRequestKeys<T>(keys: RequestKeys, fn: () => T): T {
  return keyStore.run(keys, fn);
}

/** Treat empty values and template placeholders as unset. */
function envKey(name: string): string | undefined {
  return clean(process.env[name]);
}

const KEY_ENV: Record<KeyedProvider, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
};

/** Request (BYOK) key first, then the server's env key. */
function keyFor(p: KeyedProvider): string | undefined {
  return keyStore.getStore()?.[p] ?? envKey(KEY_ENV[p]);
}

/** Where the effective key for a provider comes from, for the UI (never the key itself). */
export function keySource(p: KeyedProvider): "byok" | "env" | null {
  if (keyStore.getStore()?.[p]) return "byok";
  return envKey(KEY_ENV[p]) ? "env" : null;
}

export function hasKey(p: KeyedProvider): boolean {
  return !!keyFor(p);
}

export function apiKey(p: KeyedProvider): string {
  const k = keyFor(p);
  if (!k) throw new Error(`No ${p} API key: add one under "API keys" in the app (or set ${KEY_ENV[p]} for local use)`);
  return k;
}

/** Remove any known key (request-scoped or env) from text before it is logged, stored or returned. */
export function scrub(text: string): string {
  let out = text;
  const secrets = [...Object.values(keyStore.getStore() ?? {}), ...Object.values(KEY_ENV).map(envKey)];
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("[redacted-key]");
  return out.replace(/\b(sk-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{20,})\b/g, "[redacted-key]");
}

export function scrubError(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  const msg = scrub(e.message);
  if (msg === e.message && !e.stack) return e;
  const out = new Error(msg);
  out.stack = e.stack ? scrub(e.stack) : undefined;
  return out;
}

function pick(envName: string, order: ProviderName[]): ProviderName {
  // A key the client supplied wins over the server's env-selected provider.
  const store = keyStore.getStore();
  if (store) for (const p of order) if (p !== "mock" && store[p]) return p;
  return envPick(envName, order);
}

function envPick(envName: string, order: ProviderName[]): ProviderName {
  const explicit = process.env[envName]?.trim() as ProviderName | undefined;
  if (explicit) return explicit;
  for (const p of order) if (p !== "mock" && envKey(KEY_ENV[p])) return p;
  return "mock";
}

const LLM_ORDER: ProviderName[] = ["openrouter", "anthropic", "gemini"];
const IMAGE_ORDER: ProviderName[] = ["openrouter", "openai", "gemini"];

/** Env model overrides were written for the env-selected provider; ignore them if a BYOK key switched providers. */
function envModel(name: string, provider: ProviderName, kind: "llm" | "image"): string | undefined {
  const v = process.env[name]?.trim();
  if (!v) return undefined;
  const base = kind === "llm" ? envPick("LLM_PROVIDER", LLM_ORDER) : envPick("IMAGE_PROVIDER", IMAGE_ORDER);
  return base === provider ? v : undefined;
}

/** `llm` handles general orchestration; `synthesis` the first-principles analysis and the concept/mechanism. */
const DEFAULT_MODELS: Record<ProviderName, { llm: string; synthesis: string; candidate: string; regen: string }> = {
  openrouter: { llm: "openai/gpt-6-luna", synthesis: "anthropic/claude-sonnet-5.5", candidate: "openai/gpt-image-2", regen: "google/gemini-nano-banana-2.1" },
  anthropic: { llm: "claude-sonnet-5-5", synthesis: "claude-sonnet-5-5", candidate: "", regen: "" },
  gemini: { llm: "gemini-3.5-flash", synthesis: "gemini-3.5-flash", candidate: "gemini-3-pro-image", regen: "gemini-3-pro-image" },
  openai: { llm: "", synthesis: "", candidate: "gpt-image-2", regen: "gpt-image-2" },
  mock: { llm: "mock", synthesis: "mock", candidate: "mock", regen: "mock" },
};

export type LlmTier = "synthesis" | "general";

export const config = {
  root: ROOT,
  dataDir: process.env.DATA_DIR || path.join(ROOT, "data", "projects"),
  port: Number(process.env.PORT ?? 8790),
  get llmProvider() {
    return pick("LLM_PROVIDER", LLM_ORDER);
  },
  get imageProvider() {
    return pick("IMAGE_PROVIDER", IMAGE_ORDER);
  },
  get llmModel() {
    return envModel("LLM_MODEL", this.llmProvider, "llm") || DEFAULT_MODELS[this.llmProvider].llm;
  },
  get synthesisModel() {
    return envModel("LLM_SYNTHESIS_MODEL", this.llmProvider, "llm") || DEFAULT_MODELS[this.llmProvider].synthesis;
  },
  /** Model for one task: LLM_MODEL_<TASK> overrides, else the tier's model. */
  llmModelFor(task: string, tier: LlmTier = "general") {
    return envModel(`LLM_MODEL_${task.toUpperCase()}`, this.llmProvider, "llm") || (tier === "synthesis" ? this.synthesisModel : this.llmModel);
  },
  get candidateModel() {
    return envModel("CANDIDATE_IMAGE_MODEL", this.imageProvider, "image") || DEFAULT_MODELS[this.imageProvider].candidate;
  },
  get regenModel() {
    return envModel("REGEN_IMAGE_MODEL", this.imageProvider, "image") || DEFAULT_MODELS[this.imageProvider].regen;
  },
  get vectorModel() {
    return process.env.VECTOR_IMAGE_MODEL || "recraft/recraft-v4.1-vector";
  },
  get draftModel() {
    return envModel("DRAFT_IMAGE_MODEL", this.imageProvider, "image") || (this.imageProvider === "openrouter" ? "recraft/recraft-v4.1-flash" : this.candidateModel);
  },
  /** Whole-figure composition drafts: must handle a full diagram with labels, so a capable but quick model. */
  get compositionDraftModel() {
    return envModel("COMPOSITION_DRAFT_MODEL", this.imageProvider, "image") || (this.imageProvider === "openrouter" ? "recraft/recraft-v4.1-flash" : this.candidateModel);
  },
  get layerModel() {
    return process.env.LAYER_IMAGE_MODEL || "inclusionai/ming-image-0.1-design-layer";
  },
};
