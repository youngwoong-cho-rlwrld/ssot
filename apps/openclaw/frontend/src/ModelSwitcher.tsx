import { useState } from "react";
import { KeyRound } from "lucide-react";
import { ModelSwitcher as SharedModelSwitcher } from "@ssot/ui/ModelSwitcher";
import { resolveCatalog } from "@ssot/ui/models-catalog";
import { getModels, setDefaultModel, setModelAuth } from "./api";
import { useAsyncData } from "./hooks";
import { errMessage } from "./util";

// The gateway's default-model picker. Owns the model data + the per-provider
// API-key flow; the trigger/listbox presentation is the shared @ssot/ui
// ModelSwitcher, and the option list is the shared canonical catalog resolved
// against the daemon's live models, so it matches model-diagram + results-sheet.
export function ModelSwitcher() {
  const { data, error, setError, reload, mounted } = useAsyncData((signal) =>
    getModels(signal),
  );
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [configure, setConfigure] = useState<string | null>(null); // provider id
  const [keyInput, setKeyInput] = useState("");

  const activeKey =
    data?.models.find((m) => m.isDefault)?.key ?? data?.resolvedDefault ?? "";
  const current =
    data?.models.find((m) => m.isDefault)?.name ?? data?.resolvedDefault ?? "unknown";

  // Canonical catalog resolved against the daemon's live models: every entry
  // appears in one shared order; ids that the daemon exposes are enabled (select
  // via the daemon key), the rest are disabled with a reason tooltip. All items
  // are additionally greyed while a mutation is in flight.
  const options = resolveCatalog(data?.models ?? []).map((option) =>
    busy ? { ...option, disabled: true } : option,
  );

  const choose = async (id: string) => {
    const m = data?.models.find((x) => x.key === id);
    if (!m) return;
    if (m.available) {
      setBusy(true);
      setError(null);
      setNote(null);
      try {
        await setDefaultModel(m.key);
        await reload();
        if (mounted.current) {
          setNote(`Default is now ${m.name}.`);
          setOpen(false);
        }
      } catch (err) {
        if (mounted.current) setError(errMessage(err));
      } finally {
        if (mounted.current) setBusy(false);
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
      if (mounted.current) {
        setKeyInput("");
        setConfigure(null);
      }
      await reload();
      if (mounted.current) setNote(`Saved ${configure} credentials.`);
    } catch (err) {
      if (mounted.current) setError(errMessage(err));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const header = (
    <>
      {error && <div className="model-switcher__err">{error}</div>}
      {!data && <div className="model-switcher__msg">Loading…</div>}
    </>
  );

  return (
    <SharedModelSwitcher
      value={activeKey}
      options={options}
      onChange={(id) => void choose(id)}
      title="Default model"
      fallbackLabel={current}
      open={open}
      onOpenChange={setOpen}
      header={header}
      footer={
        note && !configure ? <div className="model-switcher__note">{note}</div> : undefined
      }
    >
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
      ) : undefined}
    </SharedModelSwitcher>
  );
}
