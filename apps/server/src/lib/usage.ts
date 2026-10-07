import { AsyncLocalStorage } from "node:async_hooks";
import type { UsageEvent } from "@diagram/core";
import { update } from "./store.js";

/** The project + stage a provider call belongs to, carried implicitly through async calls. */
const ctx = new AsyncLocalStorage<{ projectId: string; stage: string }>();

export function withStage<T>(projectId: string, stage: string, fn: () => Promise<T>): Promise<T> {
  return ctx.run({ projectId, stage }, fn);
}

export const currentStage = () => ctx.getStore();

/** Append a cost/latency record to the current project (no-op outside `withStage`). */
export async function recordUsage(e: Omit<UsageEvent, "at" | "stage" | "ok"> & { ok?: boolean }) {
  const c = ctx.getStore();
  if (!c) return;
  await update(c.projectId, (p) => {
    p.usage.push({ at: new Date().toISOString(), stage: c.stage, ok: true, ...e });
  });
}

/** Time a provider call. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t0) };
}
