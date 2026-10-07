import fs from "node:fs/promises";
import path from "node:path";
import { projectDir } from "./store.js";
import { currentStage } from "./usage.js";

/**
 * Append-only audit trail per project (data/projects/<id>/log.jsonl): every prompt and
 * response, image request, and user decision. Kept out of project.json so SSE stays small.
 */
export type LogEvent =
  | { type: "llm"; name: string; model: string; attempt: number; system: string; messages: unknown; response?: unknown; error?: string; ms: number; cost: number | null }
  | { type: "image"; model: string; prompt: string; params: Record<string, unknown>; references: number; outputs?: number; error?: string; ms: number; cost: number | null; ref?: string }
  | { type: "action"; method: string; path: string; body: unknown };

const queues = new Map<string, Promise<void>>();

export function appendLog(projectId: string, e: LogEvent & { stage?: string }) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...e }) + "\n";
  const file = path.join(projectDir(projectId), "log.jsonl");
  const next = (queues.get(projectId) ?? Promise.resolve()).then(() => fs.appendFile(file, line)).catch((err) => {
    console.error("log write failed", err);
  });
  queues.set(projectId, next);
  return next;
}

/** Log from inside a pipeline stage (no-op outside `withStage`). */
export function logStage(e: LogEvent) {
  const c = currentStage();
  return c ? appendLog(c.projectId, { stage: c.stage, ...e }) : Promise.resolve();
}

export async function readLog(projectId: string): Promise<unknown[]> {
  const raw = await fs.readFile(path.join(projectDir(projectId), "log.jsonl"), "utf8").catch(() => "");
  return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Messages with image bytes replaced by a short placeholder. */
export function loggableMessages(messages: { role: string; content: unknown }[]) {
  return messages.map((m) => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.map((p: { type: string; text?: string; data?: Buffer; mediaType?: string }) =>
          p.type === "image" ? `[image ${p.mediaType} ${p.data?.length ?? 0} bytes]` : p.text,
        )
      : m.content,
  }));
}
