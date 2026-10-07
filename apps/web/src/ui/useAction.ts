import { useCallback, useRef, useState } from "react";

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Wraps an async action with pending/error state. Re-entrant calls while pending are ignored,
 * so double-clicks never fire twice. Errors are captured (not thrown); `run` resolves to undefined on failure.
 */
export function useAction<A extends unknown[], T>(fn: (...args: A) => Promise<T>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const latest = useRef(fn);
  latest.current = fn;
  const run = useCallback(async (...args: A): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      return await latest.current(...args);
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return { run, pending, error, clearError };
}
