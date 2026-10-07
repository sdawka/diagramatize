import { useEffect, useState } from "react";
import type { Project, Stage } from "@diagram/core";
import { stylePreset } from "@diagram/core";
import { api } from "../lib/api";
import { AsyncButton } from "../ui/AsyncButton";
import { Skeleton, SkeletonCard } from "../ui/Skeleton";
import { isRunning } from "./JobBanner";
import { StyleSwitcher } from "./Style";

/** Minimal markdown: paragraphs and **bold**. */
function Prose({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i}>
          {para.split(/(\*\*[^*]+\*\*)/).map((s, j) =>
            s.startsWith("**") ? <strong key={j}>{s.slice(2, -2)}</strong> : <span key={j}>{s}</span>,
          )}
        </p>
      ))}
    </>
  );
}

export function Concept({ project, onShow }: { project: Project; onShow?: (s: Stage) => void }) {
  const [feedback, setFeedback] = useState("");
  const [restyled, setRestyled] = useState<string | null>(null);
  // null = untouched, so a re-draft's new main point shows through.
  const [mainPoint, setMainPoint] = useState<string | null>(null);
  useEffect(() => setMainPoint(null), [project.concept?.mainPoint]);
  const busy = isRunning(project.job);
  const drafting = busy && project.job?.kind === "concept";
  const g = project.concept;
  const post = (body: object = {}) => api.post(`/api/projects/${project.id}/concept`, body);
  if (!g) {
    if (!busy && !project.job?.kind.startsWith("concept"))
      return (
        <div className="panel">
          <section className="card">
            <h2>No concept yet</h2>
            <p className="muted">The agent drafts a concept from the analysis and your answers.</p>
            <div className="actions">
              <AsyncButton className="primary" onClick={() => post()} pendingLabel="Starting…">
                Draft concept →
              </AsyncButton>
            </div>
          </section>
        </div>
      );
    return (
      <div className="panel" aria-busy={busy}>
        <SkeletonCard lines={5} caption={busy ? "Drafting the concept — title, explanation, elements and palette…" : "The concept draft didn't finish. Use Retry above."}>
          <div className="palette">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} width={30} height={30} />
            ))}
          </div>
        </SkeletonCard>
        <SkeletonCard lines={4} heading={false} />
      </div>
    );
  }
  const label = (id: string) => g.nodes.find((n) => n.id === id)?.label ?? id;
  const original = (g.mainPoint ?? "").trim();
  const point = mainPoint ?? original;
  const missing = !original;
  const pointChanged = point.trim() !== original;
  const alternatives = [original, ...(g.mainPointAlternatives ?? [])].filter((t, i, all) => t && all.indexOf(t) === i);
  const redraftPoint = () =>
    post({ feedback: `The figure's main point must be: ${point.trim()}. Rebuild the concept around it.` }).then(() => setMainPoint(null));
  const approveBlock = missing ? "Set the main point first — the concept is re-drafted around it." : pointChanged ? "Re-draft with your main point first, or reset it." : undefined;

  return (
    <div className="panel">
      {drafting && (
        <p className="muted small revising-note" role="status">
          Re-drafting… the current draft stays visible until the new one arrives.
        </p>
      )}
      <section className={`card main-point ${pointChanged || missing ? "attention" : ""}`}>
        <h3 id="main-point-label">Main point of this figure</h3>
        {alternatives.length > 1 && (
          <>
            <p className="muted small">The takeaway could go a few ways — which matters most?</p>
            <div className="chips" role="group" aria-label="Candidate takeaways">
              {alternatives.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={`chip-btn wrap ${point.trim() === t ? "on" : ""}`}
                  aria-pressed={point.trim() === t}
                  disabled={busy}
                  onClick={() => setMainPoint(t)}
                >
                  {point.trim() === t && <span aria-hidden>✓ </span>}
                  {t}
                </button>
              ))}
            </div>
          </>
        )}
        <input
          className="main-point-input"
          aria-labelledby="main-point-label"
          placeholder="What should a viewer walk away with?"
          value={point}
          disabled={busy}
          onChange={(e) => setMainPoint(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setMainPoint(null)}
        />
        <div className="actions">
          <span className="muted small grow">
            {missing && !point.trim()
              ? "This concept has no main point yet. Write one and the concept is re-drafted around it."
              : pointChanged
                ? "Changed — the concept is re-drafted around this takeaway (one LLM call)."
                : "Looks right? Approving the concept below confirms it."}
          </span>
          {pointChanged && !missing && (
            <button type="button" disabled={busy} onClick={() => setMainPoint(null)}>
              Reset
            </button>
          )}
          {pointChanged && (
            <AsyncButton className="primary" disabled={busy || !point.trim()} pendingLabel="Starting…" onClick={redraftPoint}>
              Re-draft with this main point
            </AsyncButton>
          )}
        </div>
      </section>

      <div className={`panel ${drafting ? "is-busy" : ""}`} aria-busy={drafting}>
        <section className="card">
          <h2>{g.title}</h2>
          <Prose text={g.prose} />
          <div className="chips">
            <span className="chip">layout: {g.layoutIntent}</span>
            <span className="chip">direction: {g.direction === "RIGHT" ? "left → right" : "top → bottom"}</span>
            <span className="chip" title={g.style}>
              style: {stylePreset(project.stylePreset).label}
            </span>
          </div>
          <div className="palette">
            {g.palette.map((c) => (
              <span key={c.hex} className="swatch" title={`${c.name} ${c.hex}`} style={{ background: c.hex }} />
            ))}
          </div>
        </section>

        <section className="card two-col">
          <div>
            <h3>Elements</h3>
            <table>
              <tbody>
                {g.nodes.map((n) => (
                  <tr key={n.id}>
                    <td>
                      <strong>{n.label}</strong>
                    </td>
                    <td className="muted">{n.visual}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h3>Relationships</h3>
            <ul>
              {g.edges.map((e, i) => (
                <li key={i}>
                  {label(e.from)} → {label(e.to)}
                  {e.label && <span className="muted"> ({e.label})</span>}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <details className="card">
          <summary>Image prompt</summary>
          <p className="mono small">{g.imagePrompt}</p>
        </details>
      </div>

      <section className="card">
        <h3>Style</h3>
        <StyleSwitcher
          project={project}
          disabled={busy}
          hint={restyled ? undefined : "Saved immediately. You'll be asked before the concept is re-drafted."}
          onApplied={(preset) => setRestyled(preset)}
        />
        {restyled && !busy && (
          <div className="confirm" role="group" aria-label="Apply style change">
            <span className="grow">
              Style set to <strong>{stylePreset(restyled).label}</strong>. Re-draft the concept so the palette and image prompt match? This
              makes one LLM call.
            </span>
            <button type="button" onClick={() => setRestyled(null)}>
              Keep current draft
            </button>
            <AsyncButton
              className="primary"
              pendingLabel="Starting…"
              onClick={() =>
                post({ feedback: `Restyle for the "${stylePreset(restyled).label}" visual style brief now selected (palette, tone, image prompt).` }).then(() =>
                  setRestyled(null),
                )
              }
            >
              Re-draft with new style
            </AsyncButton>
          </div>
        )}
      </section>

      <section className="card">
        <h3>Feedback</h3>
        <textarea
          rows={2}
          aria-label="What should change in the concept?"
          disabled={busy}
          placeholder="What should change? (e.g. 'show the cache miss path too', 'use a kitchen metaphor')"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <div className="actions">
          <span className="muted small grow">
            {project.conceptApproved
              ? "Approved — next, plan the composition."
              : busy
                ? "Wait for the current job to finish."
                : (approveBlock ?? "Revise with feedback, or approve to confirm the main point and move on to composition.")}
          </span>
          <AsyncButton
            disabled={busy || !feedback.trim()}
            title={!feedback.trim() ? "Write some feedback first" : undefined}
            pendingLabel="Sending…"
            onClick={() => post({ feedback }).then(() => setFeedback(""))}
          >
            Revise
          </AsyncButton>
          {project.conceptApproved ? (
            onShow && (
              <button type="button" className="primary" onClick={() => onShow("composition")}>
                Go to composition →
              </button>
            )
          ) : (
            <AsyncButton
              className="primary"
              disabled={busy || !!approveBlock}
              title={approveBlock}
              pendingLabel="Approving…"
              onClick={() => api.post(`/api/projects/${project.id}/concept/approve`)}
            >
              Looks right — approve concept →
            </AsyncButton>
          )}
        </div>
      </section>
    </div>
  );
}
