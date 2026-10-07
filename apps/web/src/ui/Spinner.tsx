/** Small inline spinner. With `label` it is announced to screen readers; otherwise it is decorative. */
export function Spinner({ size, label }: { size?: number; label?: string }) {
  return (
    <span
      className="spinner"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={size ? { width: size, height: size } : undefined}
    />
  );
}
