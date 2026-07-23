import { useCallback, useEffect, useRef, useState } from "react";
import { HeartPulse, Pause, Play } from "lucide-react";
import { getHeartbeat, setHeartbeat, setPause } from "./api";
import type { HeartbeatResponse } from "./types";

const PRESETS = ["15m", "30m", "1h", "2h"];
const EVERY_RE = /^\d+[smhd]$/;

export function HeartbeatControl() {
  const [data, setData] = useState<HeartbeatResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  // Heartbeat enable/disable is a live gateway toggle not reflected in status,
  // so we track the user's intent locally for responsive UI.
  const [enabledLocal, setEnabledLocal] = useState<boolean | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback((signal?: AbortSignal) => {
    return getHeartbeat(signal)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err) => {
        if (!signal?.aborted) setError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

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

  const agent = data?.agents?.[0];
  const every = agent?.every ?? "-";
  const paused = data?.paused ?? false;
  // The backend's `enabled` is authoritative (tracks the live toggle); the
  // local override is only a transient optimistic value cleared after reload.
  const enabled = enabledLocal ?? data?.enabled ?? true;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Drop the optimistic override so the reloaded backend state drives the UI.
      setEnabledLocal(null);
      setBusy(false);
    }
  };

  const applyEvery = (value: string) => {
    if (!EVERY_RE.test(value)) {
      setError("Cadence must look like 30m, 1h, 2h.");
      return;
    }
    void run(() => setHeartbeat({ every: value }));
  };

  const toggleEnabled = () => {
    const next = !enabled;
    setEnabledLocal(next);
    void run(() => setHeartbeat({ enabled: next }));
  };

  const togglePause = () => {
    const next = !paused;
    // Pausing always disables heartbeat; resume restores its prior state, which
    // only the backend knows, so don't force an optimistic value there.
    if (next) setEnabledLocal(false);
    void run(() => setPause(next));
  };

  return (
    <div className="heartbeat" ref={rootRef}>
      <button
        type="button"
        className={`heartbeat__chip${paused ? " heartbeat__chip--paused" : ""}`}
        onClick={() => setOpen((o) => !o)}
        title="Heartbeat & pause controls"
      >
        <HeartPulse size={15} />
        <span className="heartbeat__every">{every}</span>
        <span
          className={`heartbeat__pill${
            paused ? " heartbeat__pill--paused" : enabled ? "" : " heartbeat__pill--off"
          }`}
        >
          {paused ? "paused" : enabled ? "on" : "off"}
        </span>
      </button>

      {open && (
        <div className="heartbeat__pop">
          {error && <div className="heartbeat__err">{error}</div>}

          <div className="heartbeat__section-label">Cadence</div>
          <div className="heartbeat__presets">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className={`heartbeat__preset${
                  every === p ? " heartbeat__preset--active" : ""
                }`}
                disabled={busy}
                onClick={() => applyEvery(p)}
              >
                {p}
              </button>
            ))}
          </div>
          <div className="heartbeat__custom">
            <input
              className="heartbeat__custom-input"
              placeholder="custom (e.g. 45m)"
              value={custom}
              disabled={busy}
              onChange={(e) => setCustom(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyEvery(custom.trim())}
            />
            <button
              type="button"
              className="heartbeat__custom-apply"
              disabled={busy || !custom.trim()}
              onClick={() => applyEvery(custom.trim())}
            >
              Set
            </button>
          </div>

          <label className="heartbeat__toggle">
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || paused}
              onChange={toggleEnabled}
            />
            <span>Heartbeat enabled</span>
          </label>

          <button
            type="button"
            className={`heartbeat__pause${paused ? " heartbeat__pause--resume" : ""}`}
            disabled={busy}
            onClick={togglePause}
          >
            {paused ? <Play size={15} /> : <Pause size={15} />}
            {paused ? "Resume all" : "Pause all (heartbeat + cron)"}
          </button>
        </div>
      )}
    </div>
  );
}
