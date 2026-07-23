import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { deleteSession, getSessions } from "./api";
import type { OpenClawSession } from "./types";
import {
  ACTIVE_WINDOW_MS,
  formatTokens,
  relativeTimeMs,
  sessionLabel,
} from "./util";

const POLL_MS = 15_000;

interface SessionListProps {
  selectedKey: string | null;
  onSelect: (s: OpenClawSession) => void;
  onDeleted?: (key: string) => void;
  // Start a fresh empty chat (clears selection, resets the main pane).
  onNewChat: () => void;
  // Bump to force an immediate reload (e.g. after a chat turn).
  reloadToken?: number;
}

function kindClass(kind: string): string {
  if (kind === "cron") return "kind--cron";
  if (kind === "group") return "kind--group";
  if (kind === "direct") return "kind--direct";
  return "kind--other";
}

export function SessionList({
  selectedKey,
  onSelect,
  onDeleted,
  onNewChat,
  reloadToken,
}: SessionListProps) {
  const [sessions, setSessions] = useState<OpenClawSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const aliveRef = useRef(true);

  const load = useCallback((signal?: AbortSignal) => {
    return getSessions(100, signal)
      .then((res) => {
        if (!aliveRef.current) return;
        setSessions(res.sessions ?? []);
        setError(null);
      })
      .catch((err) => {
        if (signal?.aborted || !aliveRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (aliveRef.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    let controller: AbortController | null = null;
    let timer: number | null = null;
    const tick = async () => {
      controller = new AbortController();
      await load(controller.signal);
      if (aliveRef.current) {
        timer = window.setTimeout(() => void tick(), POLL_MS);
      }
    };
    void tick();
    return () => {
      aliveRef.current = false;
      controller?.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [load, reloadToken]);

  const doDelete = async (s: OpenClawSession, force: boolean) => {
    if (!s.sessionId) return;
    setBusyKey(s.key);
    setError(null);
    try {
      await deleteSession(s.agentId, s.sessionId, force);
      setConfirmKey(null);
      setSessions((prev) => prev.filter((x) => x.key !== s.key));
      onDeleted?.(s.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
      void load();
    }
  };

  return (
    <section className="panel sessions">
      <div className="panel__head">
        <h2 className="panel__title">Sessions</h2>
        {loading && <RefreshCw size={13} className="spin panel__spin" />}
        <button
          type="button"
          className="sessions__new"
          onClick={onNewChat}
          title="Start a new chat"
        >
          <Plus size={13} />
          New chat
        </button>
      </div>

      <div className="panel__body sessions__body">
        {error && <div className="panel__status panel__status--err">{error}</div>}
        {!error && !loading && sessions.length === 0 && (
          <div className="panel__status">No sessions.</div>
        )}
        <ul className="session-list">
          {sessions.map((s) => {
            const active = s.ageMs != null && s.ageMs < ACTIVE_WINDOW_MS;
            const selected = s.key === selectedKey;
            const confirming = confirmKey === s.key;
            const busy = busyKey === s.key;
            return (
              <li key={s.key} className="session-row">
                <button
                  type="button"
                  className={`session${selected ? " session--selected" : ""}`}
                  onClick={() => onSelect(s)}
                >
                  <div className="session__top">
                    <span className={`kind ${kindClass(s.kind)}`}>{s.kind}</span>
                    {active && (
                      <span className="pulse" title="Active">
                        <span className="pulse__ring" />
                        <span className="pulse__dot" />
                      </span>
                    )}
                    <span className="session__age">{relativeTimeMs(s.updatedAt)}</span>
                  </div>
                  <div className="session__key" title={s.key}>
                    {sessionLabel(s.key)}
                  </div>
                  <div className="session__meta">
                    {s.model && <span className="session__model">{s.model}</span>}
                    <span className="session__tokens">
                      {formatTokens(s.totalTokens)} tok
                    </span>
                  </div>
                </button>

                {confirming ? (
                  <div className="session__confirm" role="group">
                    <span className="session__confirm-msg">
                      {active ? "Active, delete anyway?" : "Delete?"}
                    </span>
                    <button
                      type="button"
                      className="session__confirm-yes"
                      disabled={busy}
                      onClick={() => void doDelete(s, active)}
                    >
                      {busy ? "…" : "Yes"}
                    </button>
                    <button
                      type="button"
                      className="session__confirm-no"
                      disabled={busy}
                      onClick={() => setConfirmKey(null)}
                    >
                      No
                    </button>
                  </div>
                ) : (
                  s.sessionId && (
                    <button
                      type="button"
                      className="session__del"
                      title="Delete session"
                      aria-label="Delete session"
                      onClick={() => setConfirmKey(s.key)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
