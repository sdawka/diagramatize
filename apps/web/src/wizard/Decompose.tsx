import { useEffect, useRef, useState } from "react";
import { isVectorAsset, type BBox, type Component, type Project } from "@diagram/core";
import { api, fileUrl, useConfig } from "../lib/api";
import { isRunning, useJobStart } from "./JobBanner";
import { unitPrice, useCatalog } from "./Candidates";
import { Spinner } from "../ui/Spinner";
import { Skeleton } from "../ui/Skeleton";
import { InlineError } from "../ui/InlineError";
import { errorMessage, useAction } from "../ui/useAction";
import { fmtElapsed, useNow } from "../ui/time";
import { fmtCost } from "./Usage";
import "./stages.css";

/** Same threshold as the server: below it a trace visibly drifts from the original. */
const MIN_FIDELITY = 0.95;

type Mode = "original" | "trace" | "regenerate" | "native";

const clamp = (v: number) => Math.min(1, Math.max(0, v));

export function Decompose({ project }: { project: Project }) {
  const cfg = useConfig();
  const catalog = useCatalog();
  const busy = isRunning(project.job);
  const decomposing = busy && project.job?.kind === "decompose";
  const building = busy && project.job?.kind === "build";
  const jobStart = useJobStart(project.job);
  const now = useNow(busy);
  const picked = project.candidates.find((c) => c.id === project.pickedCandidate);
  const [comps, setComps] = useState<Component[]>(project.components);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  // Whole layers are already clean and aligned: trace them as they are unless asked otherwise.
  const [mode, setMode] = useState<Mode>(project.split === "whole" ? "original" : "regenerate");
  const [feedback, setFeedback] = useState("");
  // Save and Build share one lock; `key` says which button shows the pending state.
  const [actionKey, setActionKey] = useState<"save" | "build" | null>(null);
  const action = useAction(async (key: "save" | "build", fn: () => Promise<unknown>) => {
    setActionKey(key);
    await fn();
  });
  const posting = action.pending ? actionKey : null;
  const [rebuilding, setRebuilding] = useState<Record<string, boolean>>({});
  const [rowErr, setRowErr] = useState<Record<string, string>>({});
  const imgRef = useRef<HTMLDivElement>(null);
  const rows = useRef<Record<string, HTMLDivElement | null>>({});

  // Take server state, keeping the user's unsaved box edits on top of live build status.
  useEffect(() => {
    setComps((cs) =>
      dirty
        ? project.components.map((s) => {
            const l = cs.find((c) => c.id === s.id);
            return l ? { ...s, include: l.include, bbox: l.bbox, description: l.description } : s;
          })
        : project.components,
    );
  }, [project.components, dirty]);

  const locked = busy || !!posting;
  // Whole layers are exact pixels from the layer model; re-boxing one would swap it for a rectangular crop.
  const whole = project.split === "whole";
  const boxLocked = locked || whole;

  const patch = (id: string, p: Partial<Component>) => {
    setComps((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
    setDirty(true);
  };

  const select = (id: string | null) => {
    setSelected(id);
    if (id) rows.current[id]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  // Arrow keys nudge the selected box; with Shift they resize it.
  useEffect(() => {
    if (!selected || boxLocked) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if (e.key === "Escape") return setSelected(null);
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      const c = comps.find((x) => x.id === selected);
      if (!d || !c) return;
      e.preventDefault();
      const step = 0.005;
      const b = c.bbox;
      patch(c.id, {
        bbox: e.shiftKey
          ? { ...b, w: Math.max(0.02, Math.min(1 - b.x, b.w + d[0] * step)), h: Math.max(0.02, Math.min(1 - b.y, b.h + d[1] * step)) }
          : { ...b, x: clamp(Math.min(1 - b.w, b.x + d[0] * step)), y: clamp(Math.min(1 - b.h, b.y + d[1] * step)) },
      });
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [selected, boxLocked, comps]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!picked) return <p className="muted">Pick a candidate first.</p>;

  /** Drag the box (move) or its corner handle (resize), in normalized coordinates. */
  const startDrag = (e: React.PointerEvent, c: Component, kind: "move" | "resize") => {
    e.stopPropagation();
    e.preventDefault();
    select(c.id);
    if (locked) return;
    const rect = imgRef.current!.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, box: c.bbox };
    document.body.classList.add(kind === "move" ? "dragging-move" : "dragging-resize");
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / rect.width;
      const dy = (ev.clientY - start.y) / rect.height;
      const b = start.box;
      const next: BBox =
        kind === "move"
          ? { ...b, x: clamp(Math.min(1 - b.w, b.x + dx)), y: clamp(Math.min(1 - b.h, b.y + dy)) }
          : { ...b, w: Math.max(0.02, Math.min(1 - b.x, b.w + dx)), h: Math.max(0.02, Math.min(1 - b.y, b.h + dy)) };
      patch(c.id, { bbox: next });
    };
    const onUp = () => {
      document.body.classList.remove("dragging-move", "dragging-resize");
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onUp);
    };
    addEventListener("pointermove", onMove);
    addEventListener("pointerup", onUp);
  };

  const save = async () => {
    await api.put(`/api/projects/${project.id}/components`, {
      components: comps.map(({ id, include, bbox, description }) => ({ id, include, bbox, description })),
    });
    setDirty(false);
  };

  const opts = () => ({
    regenerate: mode === "regenerate",
    nativeSvg: mode === "native",
    keepOriginal: mode === "original",
    // "Vectorize" keeps a trace only where it is faithful to the original.
    minFidelity: mode === "trace" ? MIN_FIDELITY : undefined,
    feedback: feedback || undefined,
  });

  const build = () =>
    action.run("build", async () => {
      if (dirty) await save();
      await api.post(`/api/projects/${project.id}/build`, opts());
    });

  const rebuild = async (c: Component) => {
    setRebuilding((r) => ({ ...r, [c.id]: true }));
    setRowErr(({ [c.id]: _, ...rest }) => rest);
    try {
      if (dirty) await save();
      await api.post(`/api/projects/${project.id}/components/${c.id}/rebuild`, opts());
    } catch (e) {
      setRowErr((r) => ({ ...r, [c.id]: errorMessage(e) }));
    } finally {
      setRebuilding(({ [c.id]: _, ...rest }) => rest);
    }
  };

  const nodeLabel = (c: Component) => project.concept?.nodes.find((n) => n.id === c.nodeRef)?.label;
  const included = comps.filter((c) => c.include);
  const status = (c: Component) => (rebuilding[c.id] ? "working" : building && c.include && c.status === "pending" ? "queued" : c.status);
  const done = comps.filter((c) => c.include && c.status === "done").length;

  const perImage = (model?: string) => unitPrice(catalog.find((m) => m.id === model)?.price);
  const costHint = (model?: string) => {
    const each = perImage(model);
    if (!included.length) return "";
    return each == null ? `paid per image (${included.length} calls)` : `≈ ${fmtCost(each * included.length)} for ${included.length}`;
  };
  const modes: { id: Mode; title: string; detail: string; hint: string }[] = [
    {
      id: "original",
      title: "Keep the original pixels",
      detail: "No vectorizing: each bounded element is placed exactly as drawn. Movable, resizable and layered; not recolourable.",
      hint: "instant · free",
    },
    {
      id: "trace",
      title: "Vectorize where it's faithful",
      detail: `Traces each element and keeps the SVG only if it matches the original (≥${Math.round(MIN_FIDELITY * 100)}%); otherwise keeps the original pixels.`,
      hint: "a few seconds · free",
    },
    {
      id: "regenerate",
      title: "Regenerate with AI, then trace",
      detail: "Redraws each component cleanly on a transparent background, then vectorizes it. Best quality.",
      hint: `≈15–40s each, 3 at a time · ${costHint(cfg?.regenModel)}`,
    },
    {
      id: "native",
      title: "Native SVG model",
      detail: `Asks ${cfg?.vectorModel ?? "a vector model"} for real SVG paths — fewest nodes, may drift from the original look.`,
      hint: `≈10–30s each · ${costHint(cfg?.vectorModel)}`,
    },
  ];

  const buildBlocked = busy
    ? `Wait for the current ${project.job?.kind} job to finish`
    : !included.length
      ? "Include at least one component"
      : null;

  return (
    <div className="panel decompose">
      <div className="split">
        <div>
          <div
            className={`boxes ${boxLocked ? "locked" : ""}`}
            ref={imgRef}
            onPointerDown={() => setSelected(null)}
            onPointerLeave={() => setHover(null)}
          >
            <img src={fileUrl(project.id, picked.file)} alt="picked" draggable={false} />
            {comps.map((c) => (
              <div
                key={c.id}
                className={`box ${c.include ? "" : "excluded"} ${selected === c.id ? "selected" : ""} ${hover === c.id ? "hovered" : ""} st-${status(c)}`}
                style={{ left: `${c.bbox.x * 100}%`, top: `${c.bbox.y * 100}%`, width: `${c.bbox.w * 100}%`, height: `${c.bbox.h * 100}%` }}
                onPointerDown={(e) => !whole && startDrag(e, c, "move")}
                onPointerEnter={() => setHover(c.id)}
                title={boxLocked ? undefined : "Drag to move · corner to resize"}
              >
                <span className="box-label">
                  {status(c) === "working" && <Spinner />} {nodeLabel(c) ?? c.id}
                </span>
                {!whole && <span className="handle" onPointerDown={(e) => startDrag(e, c, "resize")} />}
              </div>
            ))}
            {decomposing && (
              <div className="boxes-overlay">
                <Spinner size={26} label="Finding components" />
                <strong>{project.job?.message ?? "Finding components…"}</strong>
                <span className="small">
                  {jobStart != null && `${fmtElapsed(now - jobStart)} elapsed · `}usually 1–3 min with layer splitting
                </span>
              </div>
            )}
          </div>
          {!decomposing && comps.length > 0 && whole && (
            <p className="muted small hint">
              Each layer is kept whole, exactly where it sits in the image — no cutting up, no invented arrows.{" "}
              {project.texts.length > 0 && <>{project.texts.length} pieces of text will be re-created as editable text. </>}
              Untick a layer to leave it out, or tick the text layer to trace the lettering instead.
            </p>
          )}
          {!decomposing && comps.length > 0 && !whole && (
            <p className="muted small hint">
              Drag a box to move it, drag its corner to resize. Arrow keys nudge the selected box (Shift resizes), Esc deselects. Untick a
              component to leave it out.
            </p>
          )}
        </div>

        <div className="comp-list">
          {decomposing &&
            Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="comp comp-skeleton" aria-busy>
                <Skeleton width={56} height={56} />
                <div className="grow">
                  <Skeleton width="70%" height={10} />
                  <Skeleton width="40%" height={10} />
                </div>
              </div>
            ))}
          {!decomposing && comps.length === 0 && (
            <p className="muted">{project.job?.kind === "decompose" && project.job.status === "error" ? "Splitting failed — go back to Images and pick again." : "No components found."}</p>
          )}
          {!decomposing &&
            comps.map((c) => {
              const st = status(c);
              const error = rowErr[c.id] ?? (c.status === "error" ? c.error : undefined);
              return (
                <div
                  key={c.id}
                  ref={(el) => {
                    rows.current[c.id] = el;
                  }}
                  className={`comp ${selected === c.id ? "selected" : ""} ${hover === c.id ? "hovered" : ""} ${c.include ? "" : "excluded"}`}
                  onClick={() => setSelected(c.id)}
                  onMouseEnter={() => setHover(c.id)}
                  onMouseLeave={() => setHover(null)}
                >
                  <input
                    type="checkbox"
                    checked={c.include}
                    disabled={locked}
                    title={c.include ? "Included in the build" : "Left out of the build"}
                    onChange={(e) => patch(c.id, { include: e.target.checked })}
                  />
                  <div className={`thumb-wrap ${st === "working" ? "working" : ""}`}>
                    {c.svg ? (
                      <img className="thumb" src={fileUrl(project.id, c.svg)} alt="" />
                    ) : c.crop ? (
                      <img className="thumb" src={`${fileUrl(project.id, c.crop)}?b=${c.bbox.x}${c.bbox.y}`} alt="" />
                    ) : (
                      <div className="thumb" />
                    )}
                    {st === "working" && (
                      <span className="thumb-spin">
                        <Spinner />
                      </span>
                    )}
                  </div>
                  <div className="grow">
                    <div>
                      <strong>{nodeLabel(c) ?? c.id}</strong> <span className="chip">{c.role}</span>{" "}
                      <span className="chip" title={whole ? "A whole layer from the layer model" : c.source === "layers" ? "Pixels isolated from model-split layers" : "Rectangular crop"}>
                        {whole ? "layer" : c.source === "layers" ? "layer-isolated" : "crop"}
                      </span>{" "}
                      {st !== "pending" && (
                        <span className={`chip status-${st}`}>{st === "working" ? "building…" : st === "done" ? "built" : st}</span>
                      )}{" "}
                      {st === "done" && c.svg && (
                        <span
                          className="chip"
                          title={
                            c.fidelity != null
                              ? `Trace matched the original ${Math.round(c.fidelity * 100)}%`
                              : "Placed as the original pixels"
                          }
                        >
                          {isVectorAsset(c.svg) ? `SVG${c.traceMethod === "centerline" ? " · centreline" : ""}${c.fidelity != null ? ` · ${Math.round(c.fidelity * 100)}%` : ""}` : `original pixels${c.fidelity != null ? ` (trace ${Math.round(c.fidelity * 100)}%)` : ""}`}
                        </span>
                      )}
                    </div>
                    <input value={c.description} disabled={locked} onChange={(e) => patch(c.id, { description: e.target.value })} />
                    {error && <div className="error small">{error}</div>}
                  </div>
                  {(st === "error" || st === "done" || rowErr[c.id]) && (
                    <button
                      className="small-btn"
                      disabled={busy || !!rebuilding[c.id]}
                      onClick={(e) => {
                        e.stopPropagation();
                        rebuild(c);
                      }}
                      title={`Rebuild just this component using “${modes.find((m) => m.id === mode)!.title}”`}
                    >
                      {st === "error" || rowErr[c.id] ? "Retry" : "Rebuild"}
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      </div>

      <section className="card">
        <div className="mode-grid" role="radiogroup" aria-label="Build mode">
          {modes.map((m) => (
            <label key={m.id} className={`mode-card ${mode === m.id ? "on" : ""} ${locked ? "disabled" : ""}`}>
              <span className="radio">
                <input type="radio" checked={mode === m.id} disabled={locked} onChange={() => setMode(m.id)} />
                <strong>{m.title}</strong>
              </span>
              <span className="small">{m.detail}</span>
              <span className="muted small">{m.hint}</span>
            </label>
          ))}
        </div>
        <div className="row">
          <input
            className="grow"
            placeholder={mode === "trace" ? "Notes only apply to AI modes" : "Notes for regeneration (optional), e.g. thicker outlines"}
            value={feedback}
            disabled={mode === "trace" || locked}
            onChange={(e) => setFeedback(e.target.value)}
          />
          {dirty && (
            <>
              <span className="chip unsaved">Unsaved box edits</span>
              <button disabled={locked} onClick={() => setDirty(false)} title="Revert to the last saved boxes">
                Discard
              </button>
              <button disabled={locked} onClick={() => action.run("save", save)}>
                {posting === "save" ? (
                  <>
                    <Spinner /> Saving…
                  </>
                ) : (
                  "Save boxes"
                )}
              </button>
            </>
          )}
          <button className="primary" disabled={!!buildBlocked || !!posting} onClick={build}>
            {posting === "build" ? (
              <>
                <Spinner /> {dirty ? "Saving & starting…" : "Starting…"}
              </>
            ) : building ? (
              <>
                <Spinner /> Building {done}/{included.length}…
              </>
            ) : (
              `Build ${included.length} component${included.length === 1 ? "" : "s"} →`
            )}
          </button>
        </div>
        {buildBlocked && !building && <p className="muted small">{buildBlocked}.</p>}
        {dirty && !buildBlocked && <p className="muted small">Building saves your box edits first.</p>}
        <InlineError error={action.error} onDismiss={action.clearError} />
      </section>
    </div>
  );
}
