import { useEffect, useState } from "react";
import type { Project } from "@diagram/core";
import { keyHeaders, useKeys } from "./keys";

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    // The one place keys leave the browser: as headers on every API call (never in URLs).
    headers: { ...keyHeaders(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

export const api = {
  get: <T>(url: string) => call<T>("GET", url),
  post: <T = unknown>(url: string, body: unknown = {}) => call<T>("POST", url, body),
  put: <T = unknown>(url: string, body: unknown) => call<T>("PUT", url, body),
};

export const fileUrl = (projectId: string, rel: string) => `/files/${projectId}/${rel}`;

export interface ServerConfig {
  llmProvider: string;
  llmModel: string;
  synthesisModel: string;
  imageProvider: string;
  candidateModel: string;
  regenModel: string;
  vectorModel: string;
  draftModel: string;
  layerModel: string;
  /** Where each provider's effective key comes from for this browser. */
  keys: Record<string, "byok" | "env" | null>;
}

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "failed";

/** Live project state, pushed from the server over SSE on every save. */
export function useProject(id: string) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  useEffect(() => {
    setProject(null);
    setError(null);
    setStatus("connecting");
    let seen = false;
    const es = new EventSource(`/api/projects/${id}/events`);
    es.addEventListener("project", (e) => {
      seen = true;
      setProject(JSON.parse((e as MessageEvent).data));
      setError(null);
      setStatus("open");
    });
    es.onerror = () => {
      if (seen) {
        setStatus("reconnecting");
        setError("Lost connection to server — retrying…");
        return;
      }
      // Never received a snapshot: distinguish a missing project from an unreachable server.
      api.get(`/api/projects/${id}`).then(
        () => setStatus("reconnecting"),
        (err: Error) => {
          if (seen) return;
          const missing = /not found|ENOENT|404/i.test(err.message);
          setError(missing ? "This project doesn't exist (it may have been deleted)." : `Can't reach the server — retrying… (${err.message})`);
          setStatus(missing ? "failed" : "reconnecting");
          if (missing) es.close();
        },
      );
    };
    return () => es.close();
  }, [id]);
  return { project, error, status };
}

export const testKey = (provider: string) => api.post<{ ok: boolean; message: string }>("/api/keys/test", { provider });

export function useConfig() {
  const [cfg, setCfg] = useState<ServerConfig | null>(null);
  const stored = useKeys();
  const sig = JSON.stringify(stored);
  useEffect(() => {
    api.get<ServerConfig>("/api/config").then(setCfg, () => {});
  }, [sig]);
  return cfg;
}
