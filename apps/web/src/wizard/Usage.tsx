import type { Project, UsageEvent } from "@diagram/core";

export const fmtCost = (c: number | null | undefined) =>
  c == null ? "cost n/a" : c === 0 ? "$0" : c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(3)}`;

export const fmtMs = (ms: number | undefined) => (ms == null ? "–" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

function summarize(events: UsageEvent[]) {
  const known = events.filter((e) => e.cost != null);
  return {
    calls: events.length,
    failed: events.filter((e) => !e.ok).length,
    cost: known.reduce((s, e) => s + (e.cost ?? 0), 0),
    unknown: events.length - known.length,
    ms: events.reduce((s, e) => s + e.ms, 0),
  };
}

/** Compact total in the stepper; click to expand per stage × model breakdown. */
export function Usage({ project }: { project: Project }) {
  const all = summarize(project.usage);
  if (!all.calls) return null;
  const groups = new Map<string, UsageEvent[]>();
  for (const e of project.usage) {
    const k = `${e.stage}\u0000${e.kind}\u0000${e.model}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  return (
    <details className="usage">
      <summary title="Provider-reported cost and summed call latency for this project">
        {fmtCost(all.cost)}
        {all.unknown > 0 && "+"} · {fmtMs(all.ms)}
      </summary>
      <div className="usage-pop">
        <table>
          <thead>
            <tr>
              <th>Stage</th>
              <th>Model</th>
              <th>Calls</th>
              <th>Avg latency</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {[...groups.entries()].map(([k, evs]) => {
              const [stage, kind, model] = k.split("\u0000");
              const s = summarize(evs);
              return (
                <tr key={k}>
                  <td>{stage}</td>
                  <td className="mono small">
                    {kind === "llm" ? "💬 " : "🖼 "}
                    {model}
                  </td>
                  <td>
                    {s.calls}
                    {s.failed > 0 && <span className="error"> ({s.failed} failed)</span>}
                  </td>
                  <td>{fmtMs(Math.round(s.ms / s.calls))}</td>
                  <td>
                    {fmtCost(s.cost)}
                    {s.unknown > 0 && <span className="muted"> +{s.unknown} n/a</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={2}>Total</td>
              <td>{all.calls}</td>
              <td>{fmtMs(all.ms)} total</td>
              <td>{fmtCost(all.cost)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </details>
  );
}
