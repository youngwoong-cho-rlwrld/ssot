import { useEffect, useState } from "react";
import { getTranscript, getTranscriptByKey } from "./api";
import type { TranscriptDetail, Turn } from "./types";
import { relativeTimeIso, sessionLabel } from "./util";

interface TranscriptPanelProps {
  agentId: string | null;
  sessionId: string | null;
  sessionKey: string | null;
  kind: string | null;
}

function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  const line = nl === -1 ? s : s.slice(0, nl);
  return line.length > 120 ? `${line.slice(0, 120)}...` : line;
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <div className={`turn turn--${turn.role}`}>
      <div className="turn__role">{turn.role}</div>
      {turn.text && <div className="turn__text">{turn.text}</div>}
      {turn.tool_calls.map((tc, i) => (
        <details key={i} className="tool">
          <summary className="tool__summary">
            <span className="tool__name">{tc.name}</span>
            <span className="tool__preview">{firstLine(tc.input_preview)}</span>
          </summary>
          <div className="tool__body">
            <div className="tool__label">input</div>
            <pre className="tool__pre">{tc.input_preview}</pre>
            {tc.output_preview != null && (
              <>
                <div className="tool__label">output</div>
                <pre className="tool__pre">{tc.output_preview}</pre>
              </>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}

export function TranscriptPanel({
  agentId,
  sessionId,
  sessionKey,
  kind,
}: TranscriptPanelProps) {
  const [detail, setDetail] = useState<TranscriptDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cron sessions have no transcript of their own (their store entry carries no
  // sessionId, or points at a runtime stub), so resolve them by key and let the
  // backend serve the latest run. Everything else fetches by sessionId.
  const byKey = kind === "cron" || !sessionId;

  useEffect(() => {
    if (!agentId || (byKey ? !sessionKey : !sessionId)) {
      setDetail(null);
      setError(null);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setDetail(null);
    const fetchDetail = byKey
      ? getTranscriptByKey(agentId, sessionKey as string, controller.signal)
      : getTranscript(agentId, sessionId as string, controller.signal);
    fetchDetail
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [agentId, sessionId, sessionKey, byKey]);

  return (
    <section className="panel transcript">
      <div className="panel__head">
        <h2 className="panel__title">Transcript</h2>
      </div>

      {detail && (
        <dl className="transcript__facts">
          {detail.model && (
            <div>
              <dt>Model</dt>
              <dd>{detail.model}</dd>
            </div>
          )}
          <div>
            <dt>Updated</dt>
            <dd>{relativeTimeIso(detail.updated_at)}</dd>
          </div>
          {sessionKey && (
            <div className="transcript__facts-wide">
              <dt>Session</dt>
              <dd title={sessionKey}>{sessionLabel(sessionKey)}</dd>
            </div>
          )}
          {detail.source === "latest_run" && (
            <div className="transcript__facts-wide">
              <dt>Showing</dt>
              <dd>latest run</dd>
            </div>
          )}
        </dl>
      )}

      <div className="panel__body transcript__body">
        {!agentId && !sessionId && (
          <div className="panel__status">Select a session to view its transcript.</div>
        )}
        {loading && <div className="panel__status">Loading transcript...</div>}
        {error && <div className="panel__status panel__status--err">{error}</div>}
        {detail && detail.turns.length === 0 && !loading && (
          <div className="panel__status">No messages on disk for this session.</div>
        )}
        {detail?.turns.map((turn, i) => (
          <TurnView key={i} turn={turn} />
        ))}
      </div>
    </section>
  );
}
