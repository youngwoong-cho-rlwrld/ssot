import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, KeyRound } from "lucide-react";
import { getModels, setDefaultModel, setModelAuth } from "./api";
import type { ModelInfo, ModelsResponse } from "./types";

export function ModelSwitcher() {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [configure, setConfigure] = useState<string | null>(null); // provider id
  const [keyInput, setKeyInput] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback((signal?: AbortSignal) => {
    return getModels(signal)
      .then((d) => setData(d))
      .catch((err) => {
        if (!signal?.aborted) setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    const c = new AbortController();
    void load(c.signal);
    return () => c.abort();
  }, [load]);

  // Close the popover on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const current =
    data?.models.find((m) => m.isDefault)?.name ??
    data?.resolvedDefault ??
    "unknown";

  const choose = async (m: ModelInfo) => {
    if (m.available) {
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        await setDefaultModel(m.key);
        await load();
        setNote(`Default is now ${m.name}.`);
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    } else {
      // Unavailable (missing credentials): open the configure flow.
      setConfigure(m.provider);
      setKeyInput("");
      setError(null);
      setNote(null);
    }
  };

  const saveKey = async () => {
    if (!configure || !keyInput.trim() || busy) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await setModelAuth(configure, keyInput);
      setKeyInput("");
      setConfigure(null);
      await load();
      setNote(`Saved ${configure} credentials.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="model-switcher" ref={rootRef}>
      <button
        type="button"
        className="model-switcher__btn"
        onClick={() => setOpen((o) => !o)}
        title="Default model"
      >
        <Cpu size={15} />
        <span className="model-switcher__current">{current}</span>
        <ChevronDown size={13} />
      </button>

      {open && (
        <div className="model-switcher__pop">
          {error && <div className="model-switcher__err">{error}</div>}
          {!data && <div className="model-switcher__msg">Loading…</div>}

          {configure ? (
            <div className="model-switcher__configure">
              <div className="model-switcher__configure-head">
                <KeyRound size={14} />
                <span>Add {configure} API key</span>
              </div>
              <input
                type="password"
                className="model-switcher__key"
                placeholder={`${configure} API key`}
                value={keyInput}
                autoFocus
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void saveKey()}
              />
              <div className="model-switcher__configure-actions">
                <button
                  type="button"
                  className="model-switcher__save"
                  disabled={busy || !keyInput.trim()}
                  onClick={() => void saveKey()}
                >
                  {busy ? "Saving…" : "Save key"}
                </button>
                <button
                  type="button"
                  className="model-switcher__cancel"
                  disabled={busy}
                  onClick={() => setConfigure(null)}
                >
                  Cancel
                </button>
              </div>
              <p className="model-switcher__hint">
                Stored locally by the gateway; applies immediately.
              </p>
            </div>
          ) : (
            <ul className="model-switcher__list">
              {data?.models.map((m) => (
                <li key={m.key}>
                  <button
                    type="button"
                    className={`model-switcher__item${
                      m.isDefault ? " model-switcher__item--active" : ""
                    }`}
                    disabled={busy}
                    onClick={() => void choose(m)}
                  >
                    <span className="model-switcher__check">
                      {m.isDefault && <Check size={13} />}
                    </span>
                    <span className="model-switcher__name">{m.name}</span>
                    <span className="model-switcher__provider">{m.provider}</span>
                    {!m.available && (
                      <span className="model-switcher__missing">missing key</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {note && !configure && <div className="model-switcher__note">{note}</div>}
        </div>
      )}
    </div>
  );
}
