import { useState } from "react";
import { api } from "../lib/api";
import { Spinner } from "../ui/Spinner";
import { fmtCost, fmtMs } from "./Usage";

type Entry = {
  at: string;
  type: "llm" | "image" | "action";
  stage?: string;
  [k: string]: unknown;
};

const json = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

function summary(e: Entry): string {
  if (e.type === "action") return `${e.method} ${e.path || "/"}`;
  if (e.type === "llm") return `${e.name} · ${e.model}${Number(e.attempt) > 0 ? ` (retry ${e.attempt})` : ""}`;
  return `${e.model}${e.ref ? ` · ${e.ref}` : ""}${e.outputs ? ` · ${e.outputs} out` : ""}`;
}

/** Full audit trail: prompts, responses, image requests and user actions. */
export function Log({ projectId }: { projectId: string }) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    return api.get<Entry[]>(`/api/projects/${projectId}/log`).then(setEntries, (e: Error) => {
      setEntries([]);
      setError(e.message);
    });
  };
  return (
    <details className="usage" onToggle={(e) => (e.currentTarget.open ? load() : setEntries(null))}>
      <summary title="Every prompt, response, image request and action for this project">Log</summary>
      <div className="usage-pop log-pop">
        <div className="row">
          <strong className="grow">
            {entries ? (
              `${entries.length} events`
            ) : (
              <>
                <Spinner /> Loading…
              </>
            )}
          </strong>
          <button onClick={load}>Refresh</button>
          <a href={`/api/projects/${projectId}/log`} target="_blank" rel="noreferrer">
            Raw JSON
          </a>
        </div>
        {error && <p className="error small">Couldn't load the log: {error}</p>}
        {entries?.length === 0 && !error && <p className="muted small">Nothing logged yet.</p>}
        {entries?.map((e, i) => (
          <details key={i} className={`log-entry log-${e.type}`}>
            <summary>
              <span className="muted small">{new Date(e.at).toLocaleTimeString()}</span>{" "}
              <span className="chip">{e.type === "action" ? "you" : e.stage}</span> {summary(e)}{" "}
              {e.type !== "action" && (
                <span className="muted small">
                  {fmtMs(e.ms as number)} · {fmtCost(e.cost as number | null)}
                </span>
              )}
              {"error" in e && e.error ? <span className="error small"> failed</span> : null}
            </summary>
            {e.type === "action" && <pre>{json(e.body)}</pre>}
            {e.type === "llm" && (
              <>
                <h4>System</h4>
                <pre>{json(e.system)}</pre>
                <h4>Messages</h4>
                <pre>{json(e.messages)}</pre>
                <h4>{e.error ? "Error" : "Response"}</h4>
                <pre>{json(e.error ?? e.response)}</pre>
              </>
            )}
            {e.type === "image" && (
              <>
                <h4>Prompt</h4>
                <pre>{json(e.prompt)}</pre>
                <h4>Params</h4>
                <pre>{json({ ...(e.params as object), references: e.references })}</pre>
                {e.error ? <pre className="error">{json(e.error)}</pre> : null}
              </>
            )}
          </details>
        ))}
      </div>
    </details>
  );
}
