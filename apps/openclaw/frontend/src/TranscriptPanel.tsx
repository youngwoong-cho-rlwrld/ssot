import { useEffect, useState } from "react";
import { getTranscript, getTranscriptByKey } from "./api";
import { Markdown } from "./Markdown";
import { ToolCallView } from "./ToolCallView";
import { ToolVisibilityToggle } from "./ToolVisibilityToggle";
import { usePersistedBool } from "./hooks";
import type { TranscriptDetail, Turn } from "./types";
import { relativeTimeIso, sessionLabel } from "./util";

interface TranscriptPanelProps {
  agentId: string | null;
  sessionId: string | null;
  sessionKey: string | null;
  kind: string | null;
}

function TurnView({
  turn,
  showTools,
}: {
  turn: Turn;
  showTools: boolean;
}) {
  return (
    <div className={`turn turn--${turn.role}`}>
      {turn.role !== "user" && turn.role !== "assistant" && (
        <div className="turn__role">{turn.role}</div>
      )}
      {turn.text && (
        <div className="turn__text">
          <Markdown>{turn.text}</Markdown>
        </div>
      )}
      {turn.tool_calls.length > 0 &&
        showTools &&
        turn.tool_calls.map((tc, i) => <ToolCallView key={i} call={tc} />)}
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
  const [showTools, toggleTools] = usePersistedBool(
    "openclaw.showToolCalls.transcript",
    true,
  );

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

  // When tool/system bubbles are hidden, drop every turn that would render
  // empty: system turns and tool-only turns with no text.
  const turns = (detail?.turns ?? []).filter(
    (t) => showTools || (t.role !== "system" && Boolean(t.text)),
  );

  return (
    <section className="panel transcript">
      <div className="panel__head">
        <h2 className="panel__title">Transcript</h2>
        <ToolVisibilityToggle
          visible={showTools}
          onToggle={toggleTools}
          context="transcript"
        />
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
        {turns.map((turn, i) => (
          <TurnView
            key={i}
            turn={turn}
            showTools={showTools}
          />
        ))}
      </div>
    </section>
  );
}
