/** Inline, announced error message with an optional dismiss button. Renders nothing without an error. */
export function InlineError({ error, onDismiss }: { error: string | null | undefined; onDismiss?: () => void }) {
  if (!error) return null;
  return (
    <span className="inline-error" role="alert">
      {error}
      {onDismiss && (
        <button type="button" className="link-btn" aria-label="Dismiss error" onClick={onDismiss}>
          ×
        </button>
      )}
    </span>
  );
}
