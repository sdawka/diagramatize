import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSwitcher } from "./Style";
import type { Candidate, Job, Project, SplitMode } from "@diagram/core";
import { api, fileUrl, useConfig } from "../lib/api";
import { fmtCost, fmtMs } from "./Usage";
import { isRunning, useJobStart } from "./JobBanner";
import { Spinner } from "../ui/Spinner";
import { InlineError } from "../ui/InlineError";
import { useAction } from "../ui/useAction";
import { fmtElapsed, useNow } from "../ui/time";
import "./stages.css";

export interface CatalogEntry {
  id: string;
  name: string;
  role: "draft" | "final" | "vector" | "layers";
  note: string;
  refsMax: number;
  price: string;
}

export function useCatalog() {
  const [models, setModels] = useState<CatalogEntry[]>([]);
  useEffect(() => {
    api.get<CatalogEntry[]>("/api/image-models").then(setModels, () => {});
  }, []);
  return models;
}

/** Per-image USD from a catalog price string; MP pricing assumes a ~1.5MP render. */
export function unitPrice(price: string | undefined): number | null {
  const m = price && /^\$([\d.]+)\/(image|MP)$/.exec(price);
  if (m) return Number(m[1]) * (m[2] === "MP" ? 1.5 : 1);
  return price === "free" ? 0 : null;
}

/** When the current running job was first seen (jobs don't carry a start time). */
/** Average latency/cost per model from this project's past candidates. */
function useHistory(candidates: Candidate[]) {
  return useMemo(() => {
    const out = new Map<string, { ms: number; cost: number | null }>();
    for (const model of new Set(candidates.map((c) => c.model))) {
      const runs = candidates.filter((c) => c.model === model);
      const costs = runs.filter((c) => c.cost != null);
      out.set(model, {
        ms: runs.reduce((s, c) => s + (c.ms ?? 0), 0) / runs.length,
        cost: costs.length ? costs.reduce((s, c) => s + c.cost!, 0) / costs.length : null,
      });
    }
    return out;
  }, [candidates]);
}

type History = ReturnType<typeof useHistory>;

function estimate(ids: string[], n: number, catalog: CatalogEntry[], history: History) {
  let cost = 0;
  const unknown: string[] = [];
  for (const id of ids) {
    const each = unitPrice(catalog.find((m) => m.id === id)?.price) ?? history.get(id)?.cost ?? null;
    if (each == null) unknown.push(id);
    else cost += each * n;
  }
  return { cost, unknown };
}

function Estimate({ ids, n, catalog, history }: { ids: string[]; n: number; catalog: CatalogEntry[]; history: History }) {
  if (!ids.length) return null;
  const { cost, unknown } = estimate(ids, n, catalog, history);
  const slowest = Math.max(0, ...ids.map((id) => history.get(id)?.ms ?? 0));
  return (
    <p className="muted small estimate">
      Est. {unknown.length === ids.length ? "cost unknown" : `≈ ${fmtCost(cost)}`}
      {unknown.length > 0 && unknown.length < ids.length && ` + ${unknown.length} token-billed model${unknown.length === 1 ? "" : "s"}`}
      {slowest > 0 && ` · ~${fmtMs(Math.round(slowest))} (runs in parallel)`}
    </p>
  );
}

function ModelPicker({
  models,
  selected,
  onChange,
  roles,
  history,
  needsRefs,
  disabled: allDisabled,
}: {
  models: CatalogEntry[];
  selected: string[];
  onChange: (ids: string[]) => void;
  roles: CatalogEntry["role"][];
  history: History;
  needsRefs?: boolean;
  disabled?: boolean;
}) {
  const [custom, setCustom] = useState("");
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const extra = selected.filter((s) => !models.some((m) => m.id === s));
  const add = () => {
    if (!selected.includes(custom.trim())) onChange([...selected, custom.trim()]);
    setCustom("");
  };
  return (
    <div className="model-picker">
      {!models.length && (
        <p className="muted small">
          <Spinner /> Loading models and prices…
        </p>
      )}
      {roles.map((role) => (
        <div key={role}>
          <div className="muted small">{role === "draft" ? "Draft (cheap, fast)" : "Final quality (slower, pricier)"}</div>
          {models
            .filter((m) => m.role === role)
            .map((m) => {
              const disabled = allDisabled || (needsRefs && m.refsMax === 0);
              const past = history.get(m.id);
              return (
                <label
                  key={m.id}
                  className={`model ${disabled ? "disabled" : ""} ${selected.includes(m.id) ? "on" : ""}`}
                  title={needsRefs && m.refsMax === 0 ? "Doesn't accept a reference image" : m.note}
                >
                  <input type="checkbox" disabled={disabled} checked={selected.includes(m.id)} onChange={() => toggle(m.id)} />
                  <span className="grow">
                    {m.name} <span className="muted small">— {needsRefs && m.refsMax === 0 ? "no reference input" : m.note}</span>
                  </span>
                  {past && <span className="muted small" title="Average in this project">~{fmtMs(Math.round(past.ms))}</span>}
                  <span className="chip" title={m.price === "token-billed" ? "Billed per token; see the usage total after a run" : undefined}>
                    {m.price}
                  </span>
                </label>
              );
            })}
        </div>
      ))}
      {extra.map((id) => (
        <label key={id} className="model on">
          <input type="checkbox" checked disabled={allDisabled} onChange={() => toggle(id)} />
          <span className="grow mono small">{id}</span>
          <span className="chip">price unknown</span>
        </label>
      ))}
      <div className="row">
        <input
          placeholder="other OpenRouter model id…"
          value={custom}
          disabled={allDisabled}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && custom.trim() && add()}
        />
        <button disabled={allDisabled || !custom.trim()} onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

/** A generation request we made, so pending images can be shown as placeholders until they arrive. */
interface Run {
  models: string[];
  n: number;
  before: Set<string>;
  started: number;
  /** The SSE update showing the job running may land after the POST resolves. */
  seen?: boolean;
}

export function Candidates({ project }: { project: Project }) {
  const cfg = useConfig();
  const catalog = useCatalog();
  const history = useHistory(project.candidates);
  const [models, setModels] = useState<string[]>([]);
  const [n, setN] = useState(2);
  const [feedback, setFeedback] = useState("");
  const [split, setSplit] = useState<SplitMode>(project.split === "boxes" || project.split === "layers" ? project.split : "whole");
  const [rerender, setRerender] = useState<Candidate | null>(null);
  const [finalModels, setFinalModels] = useState<string[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [failures, setFailures] = useState<Record<string, string>>({});
  // One action at a time across all buttons; `key` says which button shows the pending state.
  const [actionKey, setActionKey] = useState<string | null>(null);
  const action = useAction(async (key: string, url: string, body: unknown, onOk?: () => void) => {
    setActionKey(key);
    await api.post(url, body);
    onOk?.();
  });
  const posting = action.pending ? actionKey : null;
  const rerenderRef = useRef<HTMLElement>(null);
  const busy = isRunning(project.job);
  const generating = busy && project.job?.kind === "candidates";
  const jobStart = useJobStart(project.job);
  const now = useNow(busy || !!posting);

  useEffect(() => {
    if (cfg && !models.length) setModels([cfg.candidateModel]);
    if (cfg && !finalModels.length) setFinalModels([cfg.candidateModel]);
  }, [cfg]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (rerender) rerenderRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [rerender]);

  // Per-image failures arrive as "<model> failed: <reason>" progress messages.
  useEffect(() => {
    const m = generating && project.job?.message && /^(\S+) failed: (.+)$/.exec(project.job.message);
    if (m) setFailures((f) => ({ ...f, [m[1]]: m[2] }));
  }, [generating, project.job?.message]);

  useEffect(() => {
    if (!run || run.seen) return;
    if (generating) return setRun({ ...run, seen: true });
    const t = setTimeout(() => setRun((r) => r && { ...r, seen: true }), 5000);
    return () => clearTimeout(t);
  }, [run, generating]);

  const start = (ms: string[], k: number, body: object, key: string, onOk?: () => void) =>
    action.run(key, `/api/projects/${project.id}/candidates`, { models: ms, n: k, feedback: feedback || undefined, ...body }, () => {
      setRun({ models: offline ? ["image"] : ms, n: k, before: new Set(project.candidates.map((c) => c.id)), started: Date.now() });
      setFailures({});
      onOk?.();
    });

  const generate = () => start(models, n, {}, "generate");
  const renderFinal = () => start(finalModels, 1, { referenceId: rerender!.id }, "final", () => setRerender(null));

  const pick = (c: Candidate) => {
    const count = project.components.length;
    const built = project.scene || project.components.some((x) => x.svg);
    if (
      count &&
      !confirm(
        `${c.id === project.pickedCandidate ? "Re-split this image" : "Switch to this image"}? This discards the ${count} current component${count === 1 ? "" : "s"}${built ? ", their built SVGs and the workspace arrangement" : " and any box edits"}.`,
      )
    )
      return;
    action.run(`pick:${c.id}`, `/api/projects/${project.id}/pick`, { candidateId: c.id, split });
  };

  const candidates = useMemo(() => [...project.candidates].reverse(), [project.candidates]);
  const offline = cfg?.imageProvider !== "openrouter";
  const total = offline ? n : n * models.length;

  // Placeholder tiles for images of the current run that haven't arrived yet.
  const fresh = run ? project.candidates.filter((c) => !run.before.has(c.id)) : [];
  const pending = run
    ? run.models.flatMap((m) => {
        const got = fresh.filter((c) => offline || c.model === m).length;
        return Array.from({ length: Math.max(0, run.n - got) }, (_, i) => ({ model: m, key: `${m}#${i}` }));
      })
    : [];
  const stillRunning = generating || !run?.seen;
  // Only show failures the server actually reported; anything else unaccounted for is dropped quietly.
  const jobFailed = project.job?.kind === "candidates" && project.job.status === "error";
  const failedTiles = stillRunning ? [] : pending.filter((t) => failures[t.model] || jobFailed);
  const spinnerTiles = stillRunning ? pending : [];

  const generateBlocked = busy
    ? `Wait for the current ${project.job?.kind} job to finish`
    : !offline && !models.length
      ? "Select at least one model"
      : null;

  return (
    <div className="panel">
      <section className="card">
        <div className="two-col">
          <div>
            <h3>Models</h3>
            {offline ? (
              <p className="muted small">Model catalog needs the OpenRouter provider ({cfg?.imageProvider} active).</p>
            ) : (
              <ModelPicker models={catalog} selected={models} onChange={setModels} roles={["final"]} history={history} disabled={!!posting} />
            )}
          </div>
          <div className="stack">
            <StyleSwitcher project={project} />
            <label>
              Images per model
              <select value={n} onChange={(e) => setN(Number(e.target.value))}>
                {[1, 2, 3, 4].map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label>
              Adjustments (optional)
              <input value={feedback} placeholder="e.g. more whitespace, rounder icons" onChange={(e) => setFeedback(e.target.value)} />
            </label>
            <label>
              Split the picked image using
              <select value={split} onChange={(e) => setSplit(e.target.value as SplitMode)}>
                <option value="whole">Keep layers whole + editable text (recommended, ≈1–2 min)</option>
                <option value="layers">Split per concept element (experimental, ≈1–3 min)</option>
                <option value="boxes">Rectangular crops per element (≈20–40s)</option>
              </select>
            </label>
            <button className="primary" disabled={!!generateBlocked || !!posting} onClick={generate}>
              {posting === "generate" ? (
                <>
                  <Spinner /> Starting…
                </>
              ) : (
                `Generate ${total} image${total === 1 ? "" : "s"}`
              )}
            </button>
            {generateBlocked ? (
              <p className="muted small">{generateBlocked}.</p>
            ) : (
              !offline && <Estimate ids={models} n={n} catalog={catalog} history={history} />
            )}
            <p className="muted small">Tip: explore with cheap drafts, then “Render final” on the one you like.</p>
          </div>
        </div>
      </section>

      {rerender && (
        <section className="card" ref={rerenderRef}>
          <h3>Render a final version of this draft</h3>
          <p className="muted small">The draft is sent as a reference image; models that can't take one are greyed out.</p>
          <div className="split-narrow">
            <img src={fileUrl(project.id, rerender.file)} alt="draft" className="ref-thumb" />
            <ModelPicker
              models={catalog}
              selected={finalModels}
              onChange={setFinalModels}
              roles={["final", "draft"]}
              history={history}
              needsRefs
              disabled={!!posting}
            />
          </div>
          <div className="actions">
            <Estimate ids={finalModels} n={1} catalog={catalog} history={history} />
            <button onClick={() => setRerender(null)} disabled={posting === "final"}>
              Cancel
            </button>
            <button className="primary" disabled={busy || !finalModels.length || !!posting} onClick={renderFinal}>
              {posting === "final" ? (
                <>
                  <Spinner /> Starting…
                </>
              ) : (
                `Render with ${finalModels.length} model${finalModels.length === 1 ? "" : "s"}`
              )}
            </button>
          </div>
          {busy && <p className="muted small">Wait for the current {project.job?.kind} job to finish.</p>}
          {!finalModels.length && <p className="muted small">Select at least one model.</p>}
        </section>
      )}

      <InlineError error={action.error} onDismiss={action.clearError} />

      {busy && !generating && project.job?.kind === "decompose" && (
        <p className="muted">
          <Spinner /> Splitting the picked image into components — this continues on the Components step.
        </p>
      )}

      {candidates.length === 0 && !busy && !pending.length && (
        <p className="muted">Generate a few candidates, then pick the one closest to what you want with “Use →”.</p>
      )}
      {candidates.length > 0 && !project.pickedCandidate && !busy && (
        <p className="muted small">Pick the image closest to what you want with “Use →” — it gets split into editable components next.</p>
      )}

      <div className="gallery">
        {spinnerTiles.map((t) => (
          <figure key={t.key} className="tile-pending" aria-busy>
            <div className="tile-art skeleton">
              <Spinner size={22} label="Generating image" />
              <span className="small">{fmtElapsed(now - (run?.started ?? now))}</span>
            </div>
            <figcaption>
              <div className="grow">
                <div className="small mono">{t.model}</div>
                <div className="muted small">
                  Generating…{history.get(t.model) && ` usually ~${fmtMs(Math.round(history.get(t.model)!.ms))}`}
                </div>
              </div>
            </figcaption>
          </figure>
        ))}
        {generating && !run && (
          <figure className="tile-pending" aria-busy>
            <div className="tile-art skeleton">
              <Spinner />
              {jobStart && <span className="small">{fmtElapsed(now - jobStart)}</span>}
            </div>
            <figcaption>
              <div className="muted small grow">{project.job?.message ?? "Generating…"}</div>
            </figcaption>
          </figure>
        )}
        {failedTiles.map((t) => (
          <figure key={t.key} className="tile-failed">
            <div className="tile-art">
              <strong>Image failed</strong>
              <span className="small">{failures[t.model] ?? project.job?.error}</span>
            </div>
            <figcaption>
              <div className="small mono grow">{t.model}</div>
              <button onClick={() => setRun(null)}>Dismiss</button>
            </figcaption>
          </figure>
        ))}
        {candidates.map((c) => {
          const isPicked = project.pickedCandidate === c.id;
          const picking = posting === `pick:${c.id}`;
          return (
            <figure key={c.id} className={isPicked ? "picked" : ""}>
              <a href={fileUrl(project.id, c.file)} target="_blank" rel="noreferrer" title="Open full size">
                <img src={fileUrl(project.id, c.file)} alt="candidate" />
              </a>
              {isPicked && <span className="picked-badge">Picked</span>}
              <figcaption>
                <div className="grow">
                  <div className="small mono">{c.model}</div>
                  <div className="muted small">
                    {fmtMs(c.ms)} · {fmtCost(c.cost)}
                    {c.referenceId && " · from draft"}
                  </div>
                </div>
                <button disabled={busy || !!posting} onClick={() => setRerender(c)} title="Use as reference for a higher-quality model">
                  Render final
                </button>
                <button
                  className="primary"
                  disabled={busy || !!posting}
                  onClick={() => pick(c)}
                  title={
                    busy
                      ? `Wait for the current ${project.job?.kind} job to finish`
                      : isPicked
                        ? "Split this image into components again"
                        : "Split this image into editable components"
                  }
                >
                  {picking ? (
                    <>
                      <Spinner /> Starting…
                    </>
                  ) : isPicked ? (
                    "Re-split"
                  ) : (
                    "Use →"
                  )}
                </button>
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
