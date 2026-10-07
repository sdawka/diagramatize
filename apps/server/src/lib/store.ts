import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { customAlphabet } from "nanoid";
import { Project } from "@diagram/core";
import { config } from "./config.js";

export const newId = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 10);

/** Emits `project:<id>` with the latest snapshot whenever a project is saved. */
export const events = new EventEmitter();
events.setMaxListeners(100);

export function projectDir(id: string) {
  if (!/^[a-z0-9]+$/.test(id)) throw new Error("bad project id");
  return path.join(config.dataDir, id);
}

export async function createProject(topic: string, style: { stylePreset?: string; styleNotes?: string } = {}): Promise<Project> {
  const now = new Date().toISOString();
  const p = Project.parse({ id: newId(), topic, ...style, createdAt: now, updatedAt: now, stage: "clarify" });
  await fs.mkdir(projectDir(p.id), { recursive: true });
  await save(p);
  return p;
}

export async function load(id: string): Promise<Project> {
  const raw = await fs.readFile(path.join(projectDir(id), "project.json"), "utf8");
  return Project.parse(JSON.parse(raw));
}

// Writes are serialized per project so concurrent component jobs don't clobber each other.
const locks = new Map<string, Promise<unknown>>();

export async function save(p: Project): Promise<Project> {
  p.updatedAt = new Date().toISOString();
  const file = path.join(projectDir(p.id), "project.json");
  await fs.writeFile(file + ".tmp", JSON.stringify(p, null, 2));
  await fs.rename(file + ".tmp", file);
  events.emit(`project:${p.id}`, p);
  return p;
}

/** Load → mutate → save under a per-project lock. */
export async function update(id: string, fn: (p: Project) => void | Promise<void>): Promise<Project> {
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(async () => {
    const p = await load(id);
    await fn(p);
    return save(p);
  });
  locks.set(id, next.catch(() => {}));
  return next;
}

export async function list(): Promise<Pick<Project, "id" | "topic" | "stage" | "updatedAt">[]> {
  await fs.mkdir(config.dataDir, { recursive: true });
  const dirs = await fs.readdir(config.dataDir);
  const out = [];
  for (const d of dirs) {
    try {
      const p = await load(d);
      out.push({ id: p.id, topic: p.topic, stage: p.stage, updatedAt: p.updatedAt });
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function writeAsset(id: string, rel: string, data: Buffer | string) {
  const file = path.join(projectDir(id), rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
  return rel;
}

export async function readAsset(id: string, rel: string): Promise<Buffer> {
  const dir = projectDir(id);
  const file = path.resolve(dir, rel);
  if (!file.startsWith(dir + path.sep)) throw new Error("bad asset path");
  return fs.readFile(file);
}
