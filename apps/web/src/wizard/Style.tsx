import { useEffect, useState } from "react";
import type { Project } from "@diagram/core";
import { STYLE_PRESETS, stylePreset } from "@diagram/core";
import { api } from "../lib/api";
import { InlineError } from "../ui/InlineError";
import { Spinner } from "../ui/Spinner";
import { useAction } from "../ui/useAction";

/** Preset cards plus free-text notes; used when starting a project. */
export function StylePicker({
  value,
  notes,
  onChange,
}: {
  value: string;
  notes: string;
  onChange: (v: { stylePreset: string; styleNotes: string }) => void;
}) {
  return (
    <div className="style-picker">
      <div className="style-grid" role="group" aria-label="Visual style">
        {STYLE_PRESETS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`style-card ${s.id === value ? "on" : ""}`}
            aria-pressed={s.id === value}
            onClick={() => onChange({ stylePreset: s.id, styleNotes: notes })}
          >
            <strong>
              {s.label}
              {s.id === value && <span className="style-check" aria-hidden>✓</span>}
            </strong>
            <span className="muted small">{s.blurb}</span>
          </button>
        ))}
      </div>
      <input
        aria-label="Extra style notes"
        placeholder="Extra style notes (optional), e.g. 'pastel palette', 'like a 1950s science poster'"
        value={notes}
        onChange={(e) => onChange({ stylePreset: value, styleNotes: e.target.value })}
      />
    </div>
  );
}

/** Compact switcher for an existing project; saves on change. `onApplied` lets a stage react (e.g. revise the concept). */
export function StyleSwitcher({
  project,
  hint,
  disabled,
  onApplied,
}: {
  project: Project;
  hint?: string;
  disabled?: boolean;
  onApplied?: (preset: string) => void;
}) {
  const [notes, setNotes] = useState(project.styleNotes);
  useEffect(() => setNotes(project.styleNotes), [project.styleNotes]);
  const { run, pending, error, clearError } = useAction((body: { stylePreset?: string; styleNotes?: string }) =>
    api.put(`/api/projects/${project.id}/style`, body).then(() => onApplied?.(body.stylePreset ?? project.stylePreset)),
  );
  return (
    <div className="row style-switcher">
      <label>
        Visual style
        <select value={project.stylePreset} disabled={disabled || pending} onChange={(e) => run({ stylePreset: e.target.value })}>
          {STYLE_PRESETS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grow">
        Style notes
        <input
          value={notes}
          disabled={disabled}
          placeholder={stylePreset(project.stylePreset).blurb}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== project.styleNotes && run({ styleNotes: notes })}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      </label>
      {pending ? (
        <span className="muted small">
          <Spinner /> Saving…
        </span>
      ) : (
        hint && <span className="muted small">{hint}</span>
      )}
      <InlineError error={error} onDismiss={clearError} />
    </div>
  );
}
