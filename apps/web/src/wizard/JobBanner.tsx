import { useEffect, useRef, useState } from "react";
import type { Job, Stage } from "@diagram/core";
import { AsyncButton } from "../ui/AsyncButton";
import { Spinner } from "../ui/Spinner";
import { fmtElapsed, useNow } from "../ui/time";

export const isRunning = (job: Job | null) => job?.status === "running";

/** Human copy per job kind: what's happening, what finished, and a typical duration. */
export const JOB_INFO: Record<string, { running: string; done: string; failed: string; stage: Stage; typical?: string; slowAfter?: number; hint?: string }> = {
  clarify: { running: "Thinking it through from first principles", done: "Analysis ready", failed: "Analysis failed", stage: "clarify", typical: "usually 10–60s", slowAfter: 90, hint: "Your answers are kept — send them again below." },
  concept: { running: "Drafting the concept", done: "Concept drafted", failed: "Concept drafting failed", stage: "concept", typical: "usually 20–90s", slowAfter: 120 },
  composition: { running: "Planning compositions and drawing a draft of each", done: "Composition drafts ready", failed: "Composition planning failed", stage: "composition", typical: "usually 30–90s", slowAfter: 120 },
  draft: { running: "Redrawing the composition draft", done: "Draft redrawn", failed: "Redrawing failed", stage: "composition", typical: "usually 5–30s", slowAfter: 60, hint: "Your change is kept — try again." },
  prototypes: { running: "Sketching elements", done: "Sketches ready", failed: "Sketching failed", stage: "composition", typical: "usually 3–10s", slowAfter: 40 },
  candidates: { running: "Generating candidate images", done: "Candidate images ready", failed: "Image generation failed", stage: "candidates", typical: "usually 30–120s", slowAfter: 150, hint: "Adjust the options below and generate again." },
  decompose: { running: "Splitting the image into components", done: "Components ready", failed: "Decomposition failed", stage: "decompose", slowAfter: 150, hint: "Pick a candidate again to retry." },
  build: { running: "Building and vectorizing components", done: "Workspace built", failed: "Build failed", stage: "decompose", slowAfter: 180, hint: "Adjust the build options and run it again." },
};
const info = (kind: string) => JOB_INFO[kind] ?? { running: `Working on ${kind}`, done: `${kind} finished`, failed: `${kind} failed`, stage: "clarify" as Stage };

/** Start time of the current running job: the server's `startedAt`, else when this client first saw it running. */
export function useJobStart(job: Job | null) {
  const ref = useRef<{ kind: string; at: number } | null>(null);
  const server = job?.status === "running" && job.startedAt ? Date.parse(job.startedAt) : NaN;
  if (!Number.isNaN(server)) ref.current = { kind: job!.kind, at: server };
  else if (job?.status === "running") {
    if (ref.current?.kind !== job.kind) ref.current = { kind: job.kind, at: Date.now() };
  } else ref.current = null;
  return ref.current?.at ?? null;
}

export function JobBanner({
  job,
  shown,
  onShow,
  onRetry,
}: {
  job: Job | null;
  /** The step currently on screen; when the job belongs to another step, offer a jump. */
  shown?: Stage;
  onShow?: (s: Stage) => void;
  /** Retry handler for the failed job, if one makes sense for its kind. */
  onRetry?: () => Promise<unknown>;
}) {
  const started = useJobStart(job);
  const running = isRunning(job);
  const now = useNow(running);
  // Only announce "done" for jobs we watched finish, not for stale state on page load.
  const [doneSeen, setDoneSeen] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Job | null>(null);
  const prev = useRef(job);
  useEffect(() => {
    if (prev.current?.status === "running" && job?.status === "done") setDoneSeen(job.kind);
    if (job?.status === "running") setDoneSeen(null);
    prev.current = job;
  }, [job]);
  useEffect(() => {
    if (!doneSeen) return;
    const t = setTimeout(() => setDoneSeen(null), 6000);
    return () => clearTimeout(t);
  }, [doneSeen]);

  if (!job || dismissed === job) return null;
  const i = info(job.kind);
  const jump = onShow && shown && shown !== i.stage && (
    <button type="button" className="link-btn" onClick={() => onShow(i.stage)}>
      View step
    </button>
  );

  if (job.status === "done") {
    if (doneSeen !== job.kind) return null;
    return (
      <div className="banner done" role="status">
        <span aria-hidden>✓</span>
        <span className="grow">{i.done}.</span>
        {jump}
        <button type="button" className="link-btn" aria-label="Dismiss" onClick={() => setDismissed(job)}>
          ×
        </button>
      </div>
    );
  }

  if (job.status === "error") {
    return (
      <div className="banner error" role="alert">
        <div className="grow">
          <strong>{i.failed}.</strong> <span className="banner-detail">{job.error ?? "Unknown error."}</span>
          {!onRetry && <div className="muted small">{i.hint ?? "Nothing was lost — try again below."}</div>}
        </div>
        {jump}
        {onRetry && (
          <AsyncButton className="primary" onClick={onRetry} pendingLabel="Retrying…">
            Retry
          </AsyncButton>
        )}
        <button type="button" className="link-btn" aria-label="Dismiss" onClick={() => setDismissed(job)}>
          ×
        </button>
      </div>
    );
  }

  const elapsed = started ? (now - started) / 1000 : 0;
  const slow = i.slowAfter != null && elapsed > i.slowAfter;
  const pct = job.progress != null && job.progress > 0 ? Math.round(job.progress * 100) : null;
  const detail = job.message && job.message !== "Starting…" ? job.message : null;
  return (
    <div className="banner running" role="status" aria-live="polite" aria-busy="true">
      <Spinner />
      <div className="grow">
        <strong>{i.running}…</strong>
        {detail && <span className="banner-detail"> {detail}</span>}
        <div className="muted small">
          {slow ? "Taking longer than usual — still working. You can keep this tab open or come back later." : `${i.typical ? `${i.typical[0].toUpperCase()}${i.typical.slice(1)}. ` : ""}You can leave this page; progress is saved.`}
        </div>
      </div>
      {jump}
      <span
        className={`progress ${pct == null ? "indeterminate" : ""}`}
        role="progressbar"
        aria-label={i.running}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
      >
        <span style={pct == null ? undefined : { width: `${pct}%` }} />
      </span>
      {started && <span className="elapsed mono small" aria-label={`Elapsed ${fmtElapsed(now - started)}`}>{fmtElapsed(now - started)}</span>}
    </div>
  );
}
