import type { CSSProperties, ReactNode } from "react";

/** Shimmering placeholder block. */
export function Skeleton({ width, height, round, style }: { width?: CSSProperties["width"]; height?: CSSProperties["height"]; round?: boolean; style?: CSSProperties }) {
  return <span className={`skeleton ${round ? "round" : ""}`} style={{ width, height, ...style }} aria-hidden />;
}

/** A few lines of placeholder text; the last line is shorter. */
export function SkeletonText({ lines = 3 }: { lines?: number }) {
  return (
    <span className="skeleton-text" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} width={i === lines - 1 && lines > 1 ? "60%" : "100%"} />
      ))}
    </span>
  );
}

/** Card-shaped placeholder with an optional caption explaining what is being prepared. */
export function SkeletonCard({ lines = 3, heading = true, caption, children }: { lines?: number; heading?: boolean; caption?: ReactNode; children?: ReactNode }) {
  return (
    <section className="card skeleton-card" aria-busy="true">
      {caption && <p className="skeleton-caption muted small">{caption}</p>}
      {heading && <Skeleton width="40%" height="1.4em" style={{ marginBottom: 14 }} />}
      <SkeletonText lines={lines} />
      {children}
    </section>
  );
}
