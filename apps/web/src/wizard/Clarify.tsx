import { useState } from "react";
import type { Project, Stage } from "@diagram/core";
import { api } from "../lib/api";
import { AsyncButton } from "../ui/AsyncButton";
import { Skeleton, SkeletonCard } from "../ui/Skeleton";
import { isRunning } from "./JobBanner";

const WAYS: Record<string, string> = {
  "who-what": "Who / what → portrait",
  "how-much": "How much → chart",
  where: "Where → map",
  when: "When → timeline",
  how: "How → flow",
  why: "Why → cause & effect",
};

export function Clarify({ project, onShow }: { project: Project; onShow?: (s: Stage) => void }) {
  const round = project.clarify.at(-1);
  const open = round && !round.answers && round.questions.length > 0;
  // Only what the user changed this round; untouched questions fall back to the model's suggestion.
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [roundNo, setRoundNo] = useState(project.clarify.length);
  if (roundNo !== project.clarify.length) {
    setRoundNo(project.clarify.length);
    setAnswers({});
  }
  const busy = isRunning(project.job);
  const failed = project.job?.kind === "clarify" && project.job.status === "error";

  if (!round) {
    if (failed)
      return (
        <div className="panel">
          <section className="card">
            <h2>The first-principles analysis didn't finish</h2>
            <p className="muted">Run the analysis again for the same topic and style.</p>
            <div className="actions">
              <AsyncButton
                className="primary"
                pendingLabel="Starting…"
                onClick={() => api.post(`/api/projects/${project.id}/clarify`)}
              >
                Try again
              </AsyncButton>
            </div>
          </section>
        </div>
      );
    return (
      <div className="panel">
        <SkeletonCard lines={4} caption={<>Thinking about “{project.topic}” from first principles…</>}>
          <div className="chips">
            <Skeleton width={110} height={20} round />
            <Skeleton width={90} height={20} round />
            <Skeleton width={130} height={20} round />
          </div>
        </SkeletonCard>
        <SkeletonCard lines={2} caption="A few clarifying questions will appear here." />
      </div>
    );
  }
  const a = round.analysis;
  const value = (q: (typeof round.questions)[number]) => answers[q.id] ?? q.suggested ?? "";
  const effective = open ? Object.fromEntries(round.questions.map((q) => [q.id, value(q)]).filter(([, v]) => v.trim())) : {};
  const answered = Object.keys(effective).length;
  const set = (id: string, v: string) => setAnswers({ ...answers, [id]: v });
  const submit = (body: Record<string, string>) => api.post(`/api/projects/${project.id}/answers`, { answers: body });

  return (
    <div className="panel">
      <section className="card">
        <h2>First principles</h2>
        <p className="lead">{a.coreIdea}</p>
        <ul>
          {a.firstPrinciples.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
        <div className="chips">
          {a.waysOfSeeing.map((w) => (
            <span key={w} className="chip">
              {WAYS[w] ?? w}
            </span>
          ))}
        </div>
        <p>
          <strong>Recommended form:</strong> {a.recommendedDiagram}. <span className="muted">{a.rationale}</span>
        </p>
      </section>

      {open && busy ? (
        <SkeletonCard lines={3} caption="Reading your answers and refining the analysis…" />
      ) : open ? (
        <section className="card">
          <h2>A few questions</h2>
          <p className="muted small">
            {round.questions.some((q) => q.suggested)
              ? "The agent's best guesses are pre-selected — confirm them, pick another option or write your own."
              : "Pick an option or write your own."}{" "}
            Unanswered questions are left to the agent's judgement.
          </p>
          <fieldset disabled={busy} className="plain">
            {round.questions.map((q) => {
              const v = value(q);
              const isSuggestion = !(q.id in answers) && !!q.suggested;
              const custom = v !== "" && !q.options.includes(v);
              return (
                <div key={q.id} className={`question ${v.trim() ? "answered" : ""}`} role="group" aria-labelledby={`q-${q.id}`}>
                  <div className="q" id={`q-${q.id}`}>
                    {v.trim() && <span className="answered-mark" aria-label="answered">✓</span>}
                    {q.question}
                  </div>
                  <div className="muted small">{q.why}</div>
                  <div className="chips">
                    {q.options.map((o) => (
                      <button
                        key={o}
                        type="button"
                        className={`chip-btn ${v === o ? "on" : ""}`}
                        aria-pressed={v === o}
                        title={v === o ? "Click again to clear" : undefined}
                        onClick={() => set(q.id, v === o ? "" : o)}
                      >
                        {v === o && <span aria-hidden>✓ </span>}
                        {o}
                        {isSuggestion && v === o && <span className="suggested-tag">suggested</span>}
                      </button>
                    ))}
                  </div>
                  <input
                    className={custom ? "on" : ""}
                    title={custom && isSuggestion ? "Suggested by the agent" : undefined}
                    aria-label={`Your own answer to: ${q.question}`}
                    placeholder="…or write your own"
                    value={custom ? v : ""}
                    onChange={(e) => set(q.id, e.target.value)}
                  />
                </div>
              );
            })}
          </fieldset>
          <div className="actions">
            <span className="muted small grow">
              {answered} of {round.questions.length} answered
            </span>
            <AsyncButton disabled={busy} onClick={() => submit({})} pendingLabel="Skipping…" title="Let the agent decide everything">
              Skip — use your judgement
            </AsyncButton>
            <AsyncButton className="primary" disabled={busy || answered === 0} onClick={() => submit(effective)} pendingLabel="Sending…">
              {Object.keys(answers).length === 0 && answered > 0 ? "Looks right — continue →" : "Continue →"}
            </AsyncButton>
          </div>
        </section>
      ) : busy ? (
        <SkeletonCard
          lines={3}
          caption={
            project.job?.kind === "clarify"
              ? "Reading your answers — the agent may ask a follow-up or move straight on to the concept."
              : "Drafting the concept from this analysis… you'll be taken there automatically."
          }
        />
      ) : project.concept ? (
        <div className="actions next-hint">
          <p className="muted grow">Analysis complete — the concept has been drafted.</p>
          {onShow && (
            <button type="button" className="primary" onClick={() => onShow("concept")}>
              Review concept →
            </button>
          )}
        </div>
      ) : (
        <div className="actions next-hint">
          <p className="muted grow">The analysis is ready. Next, the agent drafts a concept for the diagram.</p>
          <AsyncButton className="primary" onClick={() => api.post(`/api/projects/${project.id}/concept`)} pendingLabel="Starting…">
            Draft concept →
          </AsyncButton>
        </div>
      )}
    </div>
  );
}
