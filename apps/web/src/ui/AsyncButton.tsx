import { useEffect, type ComponentProps, type ReactNode } from "react";
import { InlineError } from "./InlineError";
import { Spinner } from "./Spinner";
import { useAction } from "./useAction";

type Props = Omit<ComponentProps<"button">, "onClick"> & {
  onClick: () => Promise<unknown>;
  /** Label while the request is in flight (defaults to the normal label). */
  pendingLabel?: ReactNode;
  /** Handle errors yourself (e.g. `toast.error`); otherwise they render inline next to the button. */
  onError?: (message: string) => void;
};

/** Button for a request: shows a spinner and blocks repeat clicks while pending, and surfaces failures. */
export function AsyncButton({ onClick, pendingLabel, onError, disabled, children, ...rest }: Props) {
  const { run, pending, error, clearError } = useAction(onClick);
  useEffect(() => {
    if (error && onError) {
      onError(error);
      clearError();
    }
  }, [error, onError, clearError]);
  return (
    <>
      <button type="button" {...rest} disabled={disabled || pending} aria-busy={pending || undefined} onClick={() => void run()}>
        {pending && <Spinner />}
        {pending ? (pendingLabel ?? children) : children}
      </button>
      {!onError && <InlineError error={error} onDismiss={clearError} />}
    </>
  );
}
