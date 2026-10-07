import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { testKey, useConfig } from "../lib/api";
import { clearKey, maskKey, PROVIDERS, setKey, useKeys, type KeyedProvider } from "../lib/keys";

let open = false;
const subs = new Set<() => void>();
export function openApiKeys(v = true) {
  open = v;
  subs.forEach((f) => f());
}
const useOpen = () =>
  useSyncExternalStore(
    (f) => (subs.add(f), () => subs.delete(f)),
    () => open,
  );

function Row({ id, label, hint, source }: { id: KeyedProvider; label: string; hint: string; source: "byok" | "env" | null | undefined }) {
  const keys = useKeys();
  const stored = keys[id];
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; message: string } | "testing" | null>(null);
  const save = () => {
    if (!draft.trim()) return;
    setKey(id, draft);
    setDraft("");
    setStatus(null);
  };
  const test = async () => {
    if (draft.trim()) save();
    setStatus("testing");
    // The key was just stored, so the shared fetch wrapper attaches it.
    setStatus(await testKey(id).catch((e: Error) => ({ ok: false, message: e.message })));
  };
  return (
    <div className="key-row">
      <div className="key-head">
        <strong>{label}</strong>
        {stored ? <span className="chip status-done">in this browser</span> : source === "env" ? <span className="chip">server key</span> : <span className="chip">not set</span>}
        <span className="muted small">{hint}</span>
      </div>
      {stored && (
        <div className="key-masked">
          <code>{maskKey(stored)}</code>
        </div>
      )}
      <div className="key-input">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={`${label} API key`}
          placeholder={stored ? "Paste a new key to replace" : "Paste key"}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <button type="button" onClick={save} disabled={!draft.trim()}>
          Save
        </button>
        <button type="button" onClick={test} disabled={!stored && !draft.trim()}>
          {status === "testing" ? "Testing…" : "Test key"}
        </button>
        <button
          type="button"
          onClick={() => {
            clearKey(id);
            setStatus(null);
          }}
          disabled={!stored}
        >
          Remove
        </button>
      </div>
      {status && status !== "testing" && (
        <p className={status.ok ? "small key-ok" : "small error"} role="status">
          {status.ok ? "✓ " : ""}
          {status.message}
        </p>
      )}
    </div>
  );
}

export function ApiKeysDialog() {
  const isOpen = useOpen();
  const ref = useRef<HTMLDialogElement>(null);
  const cfg = useConfig();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (isOpen && !d.open) d.showModal();
    if (!isOpen && d.open) d.close();
  }, [isOpen]);
  return (
    <dialog ref={ref} className="keys-dialog" onClose={() => openApiKeys(false)} onClick={(e) => e.target === ref.current && openApiKeys(false)}>
      <div className="keys-body">
        <h2>API keys</h2>
        <p className="muted small">
          Bring your own keys. They are stored only in this browser (localStorage) and sent to your local server as request headers; they are never written to project files. An OpenRouter key alone is enough for text and images.
        </p>
        {cfg && (
          <p className="small">
            Active: LLM <strong>{cfg.llmProvider}</strong> · images <strong>{cfg.imageProvider}</strong>
          </p>
        )}
        {PROVIDERS.map((p) => (
          <Row key={p.id} id={p.id} label={p.label} hint={p.hint} source={cfg?.keys?.[p.id]} />
        ))}
        <div className="key-foot">
          <button type="button" className="primary" onClick={() => openApiKeys(false)}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  );
}
