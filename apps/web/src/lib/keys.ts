import { useSyncExternalStore } from "react";

export type KeyedProvider = "openrouter" | "anthropic" | "gemini" | "openai";

export const PROVIDERS: { id: KeyedProvider; label: string; hint: string; header: string }[] = [
  { id: "openrouter", label: "OpenRouter", hint: "Recommended: one key covers text and image models.", header: "X-OpenRouter-Key" },
  { id: "anthropic", label: "Anthropic", hint: "Optional: text models only.", header: "X-Anthropic-Key" },
  { id: "gemini", label: "Gemini", hint: "Optional: text and image models.", header: "X-Gemini-Key" },
  { id: "openai", label: "OpenAI", hint: "Optional: image models only.", header: "X-OpenAI-Key" },
];

const STORAGE = "diagram.byok.v1";
type Keys = Partial<Record<KeyedProvider, string>>;

let cache: Keys | null = null;
const listeners = new Set<() => void>();

function read(): Keys {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE) ?? "{}");
    cache = raw && typeof raw === "object" ? raw : {};
  } catch {
    cache = {};
  }
  return cache!;
}

function write(next: Keys) {
  cache = next;
  try {
    localStorage.setItem(STORAGE, JSON.stringify(next));
  } catch {
    // Storage blocked: keys stay in memory for this tab only.
  }
  listeners.forEach((l) => l());
}

export const getKeys = read;

export function setKey(p: KeyedProvider, value: string) {
  const v = value.trim();
  const next = { ...read() };
  if (v) next[p] = v;
  else delete next[p];
  write(next);
}

export function clearKey(p: KeyedProvider) {
  setKey(p, "");
}

/** Headers carrying every stored key. Used by the single fetch wrapper in api.ts. */
export function keyHeaders(): Record<string, string> {
  const k = read();
  const out: Record<string, string> = {};
  for (const p of PROVIDERS) if (k[p.id]) out[p.header] = k[p.id]!;
  return out;
}

export function maskKey(k: string) {
  return k.length <= 8 ? "••••" : `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

/** Re-renders when keys change; the snapshot is a version string so it stays referentially stable. */
export function useKeys(): Keys {
  useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => JSON.stringify(read()),
  );
  return read();
}
