import { useEffect, useRef, useState } from "react";
import type { Project, Stage } from "@diagram/core";
import { STAGES } from "@diagram/core";
import { api, useConfig, useProject } from "./lib/api";
import { ApiKeysDialog, openApiKeys } from "./ui/ApiKeys";
import { AsyncButton } from "./ui/AsyncButton";
import { Skeleton, SkeletonCard } from "./ui/Skeleton";
import { Spinner } from "./ui/Spinner";
import { relativeTime } from "./ui/time";
import { toast, Toaster } from "./ui/Toast";
import { Candidates } from "./wizard/Candidates";
import { Clarify } from "./wizard/Clarify";
import { Composition } from "./wizard/Composition";
import { Concept } from "./wizard/Concept";
import { Decompose } from "./wizard/Decompose";
import { JOB_INFO, JobBanner } from "./wizard/JobBanner";
import { Log } from "./wizard/Log";
import { StylePicker } from "./wizard/Style";
import { Usage } from "./wizard/Usage";
import { Workspace } from "./workspace/Workspace";

function useHashRoute() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash.match(/^#\/p\/([a-z0-9]+)/)?.[1] ?? null;
}

export function App() {
  const projectId = useHashRoute();
  const cfg = useConfig();
  const mock = cfg && (cfg.llmProvider === "mock" || cfg.imageProvider === "mock");
  return (
    <div className="app">
      <header className="topbar">
        <a href="#/" className="brand">
          Diagram Studio
        </a>
        {projectId && (
          <a href="#/" className="muted small">
            ← All projects
          </a>
        )}
        <span className="grow" />
        {cfg && (
          <span className="muted small" title={`General model: ${cfg.llmModel} · synthesis (analysis, concept): ${cfg.synthesisModel}`}>
            LLM: {cfg.llmProvider} · images: {cfg.imageProvider}
            {mock && (
              <button type="button" className="chip warn chip-btn" onClick={() => openApiKeys()}>
                offline mock — add an API key
              </button>
            )}
          </span>
        )}
        <button type="button" onClick={() => openApiKeys()}>
          API keys
        </button>
      </header>
      {projectId ? <ProjectView key={projectId} id={projectId} /> : <Home />}
      <ApiKeysDialog />
      <Toaster />
    </div>
  );
}

type Summary = Pick<Project, "id" | "topic" | "stage" | "updatedAt">;

const STAGE_NAMES: Record<Stage, string> = {
  clarify: "Think",
  concept: "Concept",
  composition: "Composition",
  candidates: "Images",
  decompose: "Components",
  workspace: "Workspace",
};

function Home() {
  const [topic, setTopic] = useState("");
  const [style, setStyle] = useState({ stylePreset: "flat", styleNotes: "" });
  const [projects, setProjects] = useState<Summary[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const load = () => {
    setListError(null);
    api.get<Summary[]>("/api/projects").then(setProjects, (e: Error) => {
      setProjects([]);
      setListError(e.message);
    });
  };
  useEffect(load, []);
  const cfg = useConfig();
  const noKey = cfg && cfg.llmProvider === "mock" && cfg.imageProvider === "mock";
  const ready = topic.trim().length > 0;
  const start = async () => {
    const p = await api.post<Project>("/api/projects", { topic, ...style });
    location.hash = `#/p/${p.id}`;
  };
  return (
    <main className="home">
      <h1>What concept should we draw?</h1>
      <p className="muted">
        The agent breaks it down from first principles, asks you a few questions, proposes a concept, then generates,
        decomposes and vectorizes it into an editable diagram.
      </p>
      {noKey && (
        <div className="key-cta" role="note">
          <span className="grow">
            No API key yet. Add an OpenRouter key to generate real diagrams; until then the app runs in an offline demo mode with placeholder content.
          </span>
          <button type="button" className="primary" onClick={() => openApiKeys()}>
            Add API key
          </button>
        </div>
      )}
      <ol className="how" aria-label="How it works">
        {STAGES.map((s, i) => (
          <li key={s}>
            <span className="how-n">{i + 1}</span> {STAGE_NAMES[s]}
          </li>
        ))}
      </ol>
      <label className="field">
        <span className="field-label">Topic</span>
        <textarea
          rows={3}
          autoFocus
          placeholder="e.g. How a TCP handshake works · Why compound interest snowballs · The water cycle"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && ready && startRef.current?.click()}
        />
      </label>
      <div className="field">
        <span className="field-label" id="style-label">
          Style <span className="muted small">— you can change it later</span>
        </span>
        <StylePicker value={style.stylePreset} notes={style.styleNotes} onChange={setStyle} />
      </div>
      <div className="start-row">
        <AsyncButton ref={startRef} className="primary big" disabled={!ready} onClick={start} pendingLabel="Starting…">
          Start →
        </AsyncButton>
        <span className="muted small">{ready ? "⌘/Ctrl + Enter to start" : "Enter a topic to start"}</span>
      </div>
      <section className="recent" aria-busy={projects === null}>
        <h3>Recent projects</h3>
        {projects === null ? (
          [0, 1, 2].map((i) => (
            <div key={i} className="recent-item">
              <Skeleton width={`${60 - i * 12}%`} />
              <Skeleton width={70} />
            </div>
          ))
        ) : listError ? (
          <p className="error small">
            Couldn't load projects ({listError}).{" "}
            <button type="button" className="link-btn" onClick={load}>
              Try again
            </button>
          </p>
        ) : projects.length === 0 ? (
          <p className="empty muted">No projects yet — your diagrams will show up here.</p>
        ) : (
          projects.map((p) => (
            <a key={p.id} href={`#/p/${p.id}`} className="recent-item">
              <span className="recent-topic">{p.topic}</span>
              <span className="recent-meta">
                <span className="chip">
                  {STAGES.indexOf(p.stage) + 1}/{STAGES.length} · {STAGE_NAMES[p.stage]}
                </span>
                <span className="muted small" title={new Date(p.updatedAt).toLocaleString()}>
                  {relativeTime(p.updatedAt)}
                </span>
              </span>
            </a>
          ))
        )}
      </section>
    </main>
  );
}

function ProjectSkeleton({ message }: { message?: string | null }) {
  return (
    <div className="project" aria-busy="true">
      <nav className="stepper">
        <Skeleton width={220} height="1.2em" />
        {STAGES.map((s) => (
          <Skeleton key={s} width={96} height={30} round />
        ))}
      </nav>
      <div className="stage panel">
        {message && (
          <p className="muted small">
            <Spinner /> {message}
          </p>
        )}
        <SkeletonCard lines={4} />
        <SkeletonCard lines={2} />
      </div>
    </div>
  );
}

function ConnectionBanner({ status, error }: { status: string; error: string | null }) {
  const was = useRef(status);
  useEffect(() => {
    if (was.current === "reconnecting" && status === "open") toast.success("Reconnected — showing the latest state.");
    was.current = status;
  }, [status]);
  if (status !== "reconnecting" || !error) return null;
  return (
    <div className="banner warn" role="status">
      <Spinner /> <span className="grow">{error} Changes made while offline may not show until it reconnects.</span>
    </div>
  );
}

function ProjectView({ id }: { id: string }) {
  const { project, error, status } = useProject(id);
  const [view, setView] = useState<Stage | null>(null);
  // Follow the pipeline forward whenever the server advances the stage.
  useEffect(() => setView(project?.stage ?? null), [project?.stage]);
  if (!project) {
    if (status === "failed")
      return (
        <main className="center">
          <div className="empty-state">
            <p>{error}</p>
            <a href="#/" className="button primary">
              Back to projects
            </a>
          </div>
        </main>
      );
    return <ProjectSkeleton message={error ?? "Loading project…"} />;
  }
  const current = STAGES.indexOf(project.stage);
  const shown = view ?? project.stage;
  const job = project.job;
  const jobStage = job?.status === "running" ? JOB_INFO[job.kind]?.stage : undefined;
  const failedStage = job?.status === "error" ? JOB_INFO[job.kind]?.stage : undefined;
  const retry =
    job?.status !== "error"
      ? undefined
      : job.kind === "concept"
        ? () => api.post(`/api/projects/${project.id}/concept`)
        : job.kind === "composition"
          ? () => api.post(`/api/projects/${project.id}/compositions`, {})
          : undefined;
  return (
    <div className="project">
      <nav className="stepper" aria-label="Pipeline steps">
        <span className="topic" title={project.topic}>
          {project.topic}
        </span>
        <ol className="steps">
          {STAGES.map((s, i) => {
            const locked = i > current;
            const state = s === jobStage ? "running" : s === failedStage ? "failed" : i < current ? "done" : i === current ? "current" : "locked";
            const tip = locked
              ? `Locked — finish ${STAGE_NAMES[STAGES[i - 1]]} first`
              : state === "running"
                ? `${STAGE_NAMES[s]} — working…`
                : state === "failed"
                  ? `${STAGE_NAMES[s]} — last run failed`
                  : state === "done"
                    ? `${STAGE_NAMES[s]} — done, click to revisit`
                    : `${STAGE_NAMES[s]} — current step`;
            return (
              <li key={s}>
                <button
                  className={`step ${s === shown ? "active" : ""} ${locked ? "" : "reached"} step-${state}`}
                  disabled={locked}
                  aria-current={s === shown ? "step" : undefined}
                  title={tip}
                  onClick={() => setView(s)}
                >
                  <span className="step-icon" aria-hidden>
                    {state === "running" ? <Spinner size={11} /> : state === "done" ? "✓" : state === "failed" ? "!" : i + 1}
                  </span>
                  {STAGE_NAMES[s]}
                  <span className="sr-only"> ({tip})</span>
                </button>
              </li>
            );
          })}
        </ol>
        <span className="grow" />
        <Usage project={project} />
        <Log projectId={project.id} />
      </nav>
      <ConnectionBanner status={status} error={error} />
      <JobBanner job={job} shown={shown} onShow={setView} onRetry={retry} />
      <div className={shown === "workspace" ? "stage stage-wide" : "stage"}>
        {shown === "clarify" && <Clarify project={project} onShow={setView} />}
        {shown === "concept" && <Concept project={project} onShow={setView} />}
        {shown === "composition" && <Composition project={project} onShow={setView} />}
        {shown === "candidates" && <Candidates project={project} />}
        {shown === "decompose" && <Decompose project={project} />}
        {shown === "workspace" && <Workspace project={project} />}
      </div>
    </div>
  );
}
