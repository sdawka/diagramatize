import { useSyncExternalStore } from "react";

type Kind = "info" | "success" | "error";
type Item = { id: number; message: string; kind: Kind };

let items: Item[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function dismissToast(id: number) {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Show a transient message. Errors stay longer. Returns the toast id. */
export function toast(message: string, kind: Kind = "info", ms = kind === "error" ? 8000 : 4000) {
  const id = nextId++;
  items = [...items.filter((t) => t.message !== message), { id, message, kind }];
  emit();
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}
toast.error = (message: string) => toast(message, "error");
toast.success = (message: string) => toast(message, "success");

/** Mount once near the app root. */
export function Toaster() {
  const list = useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => items,
  );
  return (
    <div className="toaster" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
          <span className="grow">{t.message}</span>
          <button type="button" className="link-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
