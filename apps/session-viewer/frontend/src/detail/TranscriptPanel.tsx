import { useEffect, useMemo, useState } from "react";
import { X, Copy, Check, Star, Trash2 } from "lucide-react";
import { ToolCallView } from "@ssot/ui/ToolCallView";
import { deleteSession, getDetail } from "../api";
import type { BoardNode, SessionDetail, Turn } from "../types";
import { formatAbsolute, relativeTime } from "../board/util";

const SWATCHES = [
  "#fdf0d5", // warm cream
  "#e7f0ff", // soft blue
  "#ffe5ec", // blush
  "#e3f5e1", // mint
  "#fff2c2", // sunny
  "#ece4ff", // lavender
];

interface TranscriptPanelProps {
  agent: string;
  id: string;
  uid: string;
  node: BoardNode | undefined;
  onClose: () => void;
  onUpdateNode: (uid: string, partial: Partial<Omit<BoardNode, "uid">>) => void;
  onDeleted: (uid: string) => void;
}

function resumeCommand(agent: string, cwd: string, id: string): string {
  if (agent === "claude") return `cd ${cwd} && claude --resume ${id}`;
  if (agent === "codex") return `codex resume ${id}`;
  return id;
}

export function TranscriptPanel(props: TranscriptPanelProps) {
  const { agent, id, uid, node, onClose, onUpdateNode, onDeleted } = props;

  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setDetail(null);
    getDetail(agent, id, controller.signal)
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
  }, [agent, id]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cmd = useMemo(
    () => (detail ? resumeCommand(agent, detail.cwd, id) : ""),
    [agent, detail, id],
  );

  const onCopy = async () => {
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard write failed");
    }
  };

  const onDelete = async () => {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      await deleteSession(agent, id);
      onDeleted(uid);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const starred = node?.starred ?? false;

  return (
    <>
      <div className="drawer__scrim" onClick={onClose} />
      <aside
        className="drawer"
        role="dialog"
        aria-label="Session transcript"
        aria-modal="false"
      >
        <div className="drawer__head">
          <div className="drawer__head-main">
            <div className="drawer__title" title={detail?.title}>
              {detail?.title ?? (loading ? "Loading..." : "Session")}
            </div>
          </div>
          <button
            type="button"
            className="ssot-icon-btn"
            onClick={onClose}
            title="Close"
            aria-label="Close panel"
          >
            <X size={18} />
          </button>
        </div>

        {detail && (
          <dl className="drawer__facts">
            {detail.model && (
              <div>
                <dt>Model</dt>
                <dd>{detail.model}</dd>
              </div>
            )}
            <div>
              <dt>Created</dt>
              <dd title={formatAbsolute(detail.created_at)}>
                {relativeTime(detail.created_at)}
              </dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd title={formatAbsolute(detail.updated_at)}>
                {relativeTime(detail.updated_at)}
              </dd>
            </div>
            <div>
              <dt>Messages</dt>
              <dd>{detail.message_count}</dd>
            </div>
          </dl>
        )}

        {cmd && (
          <div className="drawer__resume">
            <code className="drawer__cmd" title={cmd}>
              {cmd}
            </code>
            <button
              type="button"
              className="ssot-icon-btn"
              onClick={onCopy}
              title="Copy resume command"
              aria-label="Copy resume command"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
        )}

        {agent !== "openclaw" && <div className="drawer__danger">
          {!confirmingDelete ? (
            <button type="button" className="danger-btn" onClick={onDelete}>
              <Trash2 size={14} />
              Delete session
            </button>
          ) : (
            <div className="danger-confirm">
              <span className="danger-confirm__msg">Move to Trash?</span>
              <button
                type="button"
                className="danger-btn danger-btn--solid"
                onClick={onDelete}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete"}
              </button>
              <button
                type="button"
                className="pill-btn"
                onClick={() => setConfirmingDelete(false)}
                disabled={deleting}
              >
                Cancel
              </button>
            </div>
          )}
        </div>}

        <div className="drawer__controls">
          <div className="swatches" role="group" aria-label="Card color">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className={`swatch${node?.color === c ? " swatch--on" : ""}`}
                style={{ background: c }}
                title={`Set color ${c}`}
                aria-label={`Set color ${c}`}
                onClick={() => onUpdateNode(uid, { color: c })}
              />
            ))}
            <button
              type="button"
              className={`swatch${node?.color == null ? " swatch--on" : ""}`}
              style={{
                background: "#ffffff",
                boxShadow: "inset 0 0 0 1px var(--ssot-border-strong)",
              }}
              title="Default (no color)"
              aria-label="Reset to default color"
              onClick={() => onUpdateNode(uid, { color: null })}
            />
          </div>
          <button
            type="button"
            className={`pill-btn${starred ? " pill-btn--on" : ""}`}
            onClick={() => onUpdateNode(uid, { starred: !starred })}
            aria-pressed={starred}
          >
            <Star size={14} fill={starred ? "currentColor" : "none"} />
            {starred ? "Starred" : "Star"}
          </button>
        </div>

        <div className="drawer__body">
          {loading && <div className="drawer__status">Loading transcript...</div>}
          {error && <div className="drawer__status drawer__status--err">{error}</div>}
          {detail && detail.turns.length === 0 && !loading && (
            <div className="drawer__status">No messages.</div>
          )}
          {detail?.turns.map((turn, i) => (
            <TurnView key={i} turn={turn} />
          ))}
        </div>
      </aside>
    </>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <div className={`turn turn--${turn.role}`}>
      <div className="turn__role">{turn.role}</div>
      {turn.text && <div className="turn__text">{turn.text}</div>}
      {turn.tool_calls.map((tc, i) => (
        <ToolCallView key={i} call={tc} />
      ))}
    </div>
  );
}
