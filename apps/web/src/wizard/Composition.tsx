import { useEffect, useMemo, useRef, useState } from "react";
import {
  ASPECT_RATIOS,
  aspectValue,
  compositionSvg,
  type AspectRatio,
  type Composition as Comp,
  type CompositionItem,
  type Emphasis,
  type Project,
} from "@diagram/core";
import { api, fileUrl } from "../lib/api";
import { AsyncButton } from "../ui/AsyncButton";
import { InlineError } from "../ui/InlineError";
import { SkeletonCard } from "../ui/Skeleton";
import { Spinner } from "../ui/Spinner";
import { isRunning } from "./JobBanner";
import { fmtCost } from "./Usage";
import "./composition.css";

const EMPHASIS: Emphasis[] = ["focal", "primary", "secondary"];
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Wireframe (with element sketches when available) as inline SVG markup. */
function useMockup(project: Project, c: Comp | null, width: number) {
  const images = useMemo(
    () => Object.fromEntries(Object.entries(project.prototypes).map(([k, p]) => [k, fileUrl(project.id, p.file)])),
    [project.id, project.prototypes],
  );
  return useMemo(() => (c && project.concept ? compositionSvg(c, project.concept, { width, images }) : ""), [c, project.concept, width, images]);
}

function Thumb({ project, option, selected, drawing, onSelect }: { project: Project; option: Comp; selected: boolean; drawing: boolean; onSelect: () => void }) {
  const svg = useMockup(project, option, 600);
  return (
    <button type="button" className={`comp-option ${selected ? "on" : ""}`} aria-pressed={selected} onClick={onSelect}>
      <div className="comp-thumb" style={{ aspectRatio: String(aspectValue(option.aspectRatio)) }}>
        {option.draft ? (
          <img src={fileUrl(project.id, option.draft.file)} alt={`Draft: ${option.name}`} />
        ) : drawing ? (
          <div className="comp-thumb-wait">
            <Spinner /> Drawing…
          </div>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        )}
      </div>
      <div className="comp-option-text">
        <strong>{option.name}</strong> <span className="chip">{option.aspectRatio}</span>
        <span className="muted small">{option.rationale}</span>
      </div>
    </button>
  );
}

export function Composition({ project, onShow }: { project: Project; onShow?: (s: "candidates") => void }) {
  const busy = isRunning(project.job);
  const composing = busy && project.job?.kind === "composition";
  const sketching = busy && project.job?.kind === "prototypes";
  const redrawing = busy && project.job?.kind === "draft";
  const g = project.concept;
  const options = project.compositions;
  const [draft, setDraft] = useState<Comp | null>(project.composition ?? options[0] ?? null);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [sketchNotes, setSketchNotes] = useState("");
  const [change, setChange] = useState("");
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);

  // Follow new options from the server unless the user is mid-edit.
  useEffect(() => {
    if (!dirty) setDraft(project.composition ?? options[0] ?? null);
  }, [options, project.composition]); // eslint-disable-line react-hooks/exhaustive-deps

  const svg = useMockup(project, draft, 1200);
  const stored = options.find((o) => o.id === draft?.id) ?? draft;
  const storedSvg = useMockup(project, stored ?? null, 1200);
  const [advanced, setAdvanced] = useState(false);

  if (!g) return <p className="muted">Approve a concept first.</p>;
  if (!options.length)
    return (
      <div className="panel">
        <SkeletonCard lines={3} caption={composing ? <>{project.job?.message ?? "Planning compositions…"}</> : <>No compositions yet.</>}>
          {!busy && (
            <AsyncButton className="primary" pendingLabel="Starting…" onClick={() => api.post(`/api/projects/${project.id}/compositions`, {})}>
              Propose compositions
            </AsyncButton>
          )}
        </SkeletonCard>
      </div>
    );

  const pickOption = (o: Comp) => {
    if (dirty && draft?.id !== o.id && !confirm("Discard your adjustments to the current composition?")) return;
    setDraft(o);
    setDirty(false);
    setSelected(null);
  };
  const patchItem = (ref: string, p: Partial<CompositionItem>) => {
    setDraft((d) => d && { ...d, items: d.items.map((i) => (i.nodeRef === ref ? { ...i, ...p } : i)) });
    setDirty(true);
  };

  /** Drag to move, or drag the corner handle to resize, in normalized units. */
  const startDrag = (e: React.PointerEvent, item: CompositionItem, kind: "move" | "resize") => {
    e.stopPropagation();
    e.preventDefault();
    setSelected(item.nodeRef);
    const rect = frame.current!.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, item };
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / rect.width;
      const dy = (ev.clientY - start.y) / rect.height;
      const b = start.item;
      patchItem(
        b.nodeRef,
        kind === "move"
          ? { x: clamp01(Math.min(b.x + dx, 1 - b.w)), y: clamp01(Math.min(b.y + dy, 1 - b.h)) }
          : { w: Math.max(0.03, Math.min(1 - b.x, b.w + dx)), h: Math.max(0.03, Math.min(1 - b.y, b.h + dy)) },
      );
    };
    const onUp = () => {
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onUp);
    };
    addEventListener("pointermove", onMove);
    addEventListener("pointerup", onUp);
  };

  const onKey = (e: React.KeyboardEvent) => {
    const it = draft?.items.find((i) => i.nodeRef === selected);
    if (!it) return;
    const step = e.altKey ? 0.002 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) {
      e.preventDefault();
      if (e.shiftKey) patchItem(it.nodeRef, { w: Math.max(0.03, Math.min(1 - it.x, it.w + d[0])), h: Math.max(0.03, Math.min(1 - it.y, it.h + d[1])) });
      else patchItem(it.nodeRef, { x: clamp01(Math.min(it.x + d[0], 1 - it.w)), y: clamp01(Math.min(it.y + d[1], 1 - it.h)) });
    } else if (e.key === "Escape") setSelected(null);
  };

  const use = async () => {
    setError(null);
    try {
      await api.put(`/api/projects/${project.id}/composition`, { composition: draft });
      setDirty(false);
      onShow?.("candidates");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const sel = draft?.items.find((i) => i.nodeRef === selected);
  const label = (ref: string) => g.nodes.find((n) => n.id === ref)?.label ?? ref;
  const protoCost = Object.values(project.prototypes).reduce((s, p) => s + (p.cost ?? 0), 0);

  return (
    <div className="panel composition">
      <section className="comp-options" aria-label="Composition options">
        {options.map((o) => (
          <Thumb key={o.id} project={project} option={o} selected={draft?.id === o.id} drawing={composing} onSelect={() => pickOption(o)} />
        ))}
      </section>

      {draft && stored && (
        <section className="card comp-review">
          <div className="comp-review-art" style={{ aspectRatio: String(aspectValue(stored.aspectRatio)) }}>
            {stored.draft ? (
              <img src={fileUrl(project.id, stored.draft.file)} alt={`Draft of the whole figure: ${stored.name}`} />
            ) : (
              <div className="comp-svg" dangerouslySetInnerHTML={{ __html: storedSvg }} />
            )}
            {(redrawing || (composing && !stored.draft)) && (
              <div className="comp-review-busy">
                <Spinner size={22} /> {project.job?.message ?? "Drawing…"}
              </div>
            )}
          </div>
          <aside className="comp-review-side">
            <h3>
              {stored.name} <span className="chip">{stored.aspectRatio}</span>
            </h3>
            <p className="small">{stored.rationale}</p>
            <p className="muted small">
              <strong>Reading order:</strong> {stored.readingOrder}
              <br />
              <strong>Focal:</strong> {stored.focal}
            </p>
            {stored.draft && (
              <p className="muted small">
                A quick one-shot draft ({stored.draft.model.split("/").pop()}
                {stored.draft.cost != null && `, ${fmtCost(stored.draft.cost)}`}). Judge the arrangement, not the polish or the lettering —
                the final images redraw it properly.
              </p>
            )}
            {stored.notes.length > 0 && (
              <div className="comp-notes">
                <span className="small muted">Changes so far</span>
                <ol>
                  {stored.notes.map((n, i) => (
                    <li key={i} className="small">
                      {n}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <label className="field">
              <span className="field-label">What should change?</span>
              <textarea
                rows={3}
                value={change}
                disabled={busy}
                placeholder="e.g. make the key result bigger, swap the two left panels, less empty space at the bottom"
                onChange={(e) => setChange(e.target.value)}
              />
            </label>
            <div className="btn-row">
              <AsyncButton
                disabled={busy || !change.trim()}
                pendingLabel="Starting…"
                onClick={() => api.post(`/api/projects/${project.id}/compositions/${stored.id}/draft`, { feedback: change.trim() }).then(() => setChange(""))}
              >
                Redraw with changes
              </AsyncButton>
              <AsyncButton disabled={busy} pendingLabel="Starting…" onClick={() => api.post(`/api/projects/${project.id}/compositions/${stored.id}/draft`, {})}>
                {stored.draft ? "Another take" : "Draw it"}
              </AsyncButton>
            </div>
            <AsyncButton className="primary" disabled={busy || !draft} pendingLabel="Saving…" onClick={use}>
              Use this composition →
            </AsyncButton>
            <InlineError error={error} onDismiss={() => setError(null)} />
          </aside>
        </section>
      )}

      {draft && (
        <details className="card comp-advanced" onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary>
            Fine-tune element positions <span className="muted small">— optional; moving boxes replaces the drawn draft with a box layout guide</span>
          </summary>
          {advanced && (
        <section className="comp-editor">
          <div className="row">
            <h3 className="grow">
              {draft.name}
              {dirty && <span className="chip">adjusted</span>}
            </h3>
            <label>
              Aspect ratio
              <select
                value={draft.aspectRatio}
                onChange={(e) => {
                  setDraft({ ...draft, aspectRatio: e.target.value as AspectRatio });
                  setDirty(true);
                }}
              >
                {ASPECT_RATIOS.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="muted small">
            <strong>Reading order:</strong> {draft.readingOrder} · <strong>Focal:</strong> {draft.focal}
          </p>

          <div className="comp-stage">
            <div
              ref={frame}
              className="comp-frame"
              style={{ aspectRatio: String(aspectValue(draft.aspectRatio)) }}
              tabIndex={0}
              onKeyDown={onKey}
              onPointerDown={() => setSelected(null)}
            >
              <div className="comp-svg" dangerouslySetInnerHTML={{ __html: svg }} />
              {draft.items.map((i) => (
                <div
                  key={i.nodeRef}
                  className={`comp-hit ${selected === i.nodeRef ? "selected" : ""}`}
                  style={{ left: `${i.x * 100}%`, top: `${i.y * 100}%`, width: `${i.w * 100}%`, height: `${i.h * 100}%` }}
                  title={`${label(i.nodeRef)} — drag to move, corner to resize`}
                  onPointerDown={(e) => startDrag(e, i, "move")}
                >
                  {sketching && !project.prototypes[i.nodeRef] && <Spinner size={16} />}
                  <span className="comp-handle" onPointerDown={(e) => startDrag(e, i, "resize")} />
                </div>
              ))}
            </div>

            <aside className="comp-side">
              {sel ? (
                <>
                  <h4>{label(sel.nodeRef)}</h4>
                  <div className="btn-row" role="radiogroup" aria-label="Emphasis">
                    {EMPHASIS.map((em) => (
                      <button
                        key={em}
                        type="button"
                        role="radio"
                        aria-checked={sel.emphasis === em}
                        className={`chip-btn ${sel.emphasis === em ? "on" : ""}`}
                        onClick={() => patchItem(sel.nodeRef, { emphasis: em })}
                      >
                        {em}
                      </button>
                    ))}
                  </div>
                  {project.prototypes[sel.nodeRef] && (
                    <img className="proto-big" src={fileUrl(project.id, project.prototypes[sel.nodeRef].file)} alt="" />
                  )}
                  <input placeholder="Sketch notes, e.g. 'side view', 'simpler'" value={sketchNotes} onChange={(e) => setSketchNotes(e.target.value)} />
                  <AsyncButton
                    disabled={busy}
                    pendingLabel="Sketching…"
                    onClick={() =>
                      api
                        .post(`/api/projects/${project.id}/prototypes`, { nodeIds: [sel.nodeRef], feedback: sketchNotes || undefined })
                        .then(() => setSketchNotes(""))
                    }
                  >
                    Re-sketch this element
                  </AsyncButton>
                </>
              ) : (
                <p className="muted small">
                  Click an element to set its emphasis or re-sketch it. Drag to move, drag the corner to resize; arrow keys nudge, Shift+arrows resize.
                </p>
              )}
              <hr />
              <p className="muted small">
                Element sketches are quick drafts{protoCost > 0 && ` (${fmtCost(protoCost)} so far)`} — they show what goes where. The final images
                redraw everything in your style and follow this layout.
              </p>
              <AsyncButton disabled={busy} pendingLabel="Sketching…" onClick={() => api.post(`/api/projects/${project.id}/prototypes`, { nodeIds: g.nodes.map((n) => n.id) })}>
                Re-sketch all elements
              </AsyncButton>
            </aside>
          </div>
        </section>
          )}
        </details>
      )}

      <section className="card">
        <div className="row">
          <input
            className="grow"
            placeholder="Want different options? e.g. 'try a circular loop', 'portrait for a poster', 'put the tumour on the right'"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            disabled={busy}
          />
          <AsyncButton
            disabled={busy || !feedback.trim()}
            pendingLabel="Asking…"
            onClick={() => api.post(`/api/projects/${project.id}/compositions`, { feedback }).then(() => setFeedback(""))}
          >
            New options
          </AsyncButton>
        </div>
      </section>
    </div>
  );
}
