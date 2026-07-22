import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Ban, ChevronDown, ChevronRight, SendHorizontal } from "lucide-react";
import {
  cancelChat,
  getChat,
  getModels,
  getRun,
  openChatEvents,
  postChat,
} from "./api";
import { Markdown } from "@ssot/ui/Markdown";
import { CancelConfirmModal } from "./CancelConfirmModal";
import { ModelSelect } from "./ModelSelect";
import type { ChatMessage, ModelOption } from "./types";

interface Props {
  diagramId: number;
  runId: number; // the run being viewed; the chat is anchored to it
  open: boolean;
  onToggle: () => void;
  onRevision: (newRunId: number) => void;
}

const CANCELLED_DETAIL = "cancelled by user";

// A collapsible left-panel section (OpenClaw LIVE LOG grammar for the header) whose
// body reuses the shared @ssot/theme/chat.css grammar verbatim — the same
// panel__body.chat__body / bubble* / typing / chat__compose·input·send used by
// OpenClaw's Chat.tsx and results-sheet's ResultsAgentPanel.
export function ChatPanel({ diagramId, runId, open, onToggle, onRevision }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("");
  const bodyRef = useRef<HTMLDivElement>(null);
  const onRevisionRef = useRef(onRevision);
  onRevisionRef.current = onRevision;

  // Load history + model options (defaulting to the anchor run's model) on open.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    getChat(diagramId, controller.signal)
      .then((h) => setMessages(h.messages))
      .catch(() => {});
    Promise.all([getModels(controller.signal), getRun(runId, controller.signal)])
      .then(([m, run]) => {
        setModels(m.models);
        setModel((prev) => prev || run.model || m.default);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [diagramId, runId, open]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages, pendingId]);

  const upsert = useCallback((m: ChatMessage) => {
    setMessages((prev) => {
      const i = prev.findIndex((x) => x.id === m.id);
      if (i === -1) return [...prev, m];
      const next = prev.slice();
      next[i] = m;
      return next;
    });
  }, []);

  const busy = sending || pendingId !== null;

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setSending(true);
    // Optimistic user bubble (replaced by the server rows once the turn is created).
    setMessages((prev) => [
      ...prev,
      {
        id: -Date.now(), role: "user", content: text, status: "done", error_detail: null,
        revised_run_id: null, anchor_run_id: runId, seq: Number.MAX_SAFE_INTEGER,
        created_at: new Date().toISOString(),
      },
    ]);
    setInput("");
    try {
      const { assistant_message_id } = await postChat(diagramId, runId, text, model || undefined);
      const history = await getChat(diagramId);
      setMessages(history.messages);
      setSending(false);
      setPendingId(assistant_message_id);
      openChatEvents(assistant_message_id, {
        onMessage: (m) => {
          upsert({
            id: m.id, role: m.role, content: m.content, status: m.status,
            error_detail: m.error_detail, revised_run_id: m.revised_run_id,
            anchor_run_id: runId, seq: m.seq, created_at: new Date().toISOString(),
          });
          if (m.status !== "pending") {
            setPendingId(null);
            if (m.revised_run_id) onRevisionRef.current(m.revised_run_id);
          }
        },
        onError: () => setPendingId(null),
      });
    } catch (e) {
      setSending(false);
      setMessages((prev) => [
        ...prev,
        {
          id: -Date.now(), role: "assistant",
          content: e instanceof Error ? e.message : "Could not send the message.",
          status: "error", error_detail: null, revised_run_id: null, anchor_run_id: runId,
          seq: Number.MAX_SAFE_INTEGER, created_at: new Date().toISOString(),
        },
      ]);
    }
  }, [input, busy, diagramId, runId, model, upsert]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <section
      className={`panel vsection viewer__chat-section ${open ? "vsection--open" : "vsection--closed"}`}
    >
      <div className="panel__head vsection__head">
        <button
          type="button"
          className="vsection__toggle"
          onClick={onToggle}
          aria-expanded={open}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <h3 className="panel__title">Chat with agent</h3>
        </button>
        {open && models.length > 0 && (
          <ModelSelect value={model} options={models} onChange={setModel} disabled={busy} />
        )}
        {open && pendingId !== null && (
          <button
            type="button"
            className="ssot-icon-btn"
            onClick={() => setConfirmCancel(true)}
            title="Stop the reply"
            aria-label="Stop the reply"
          >
            <Ban size={15} />
          </button>
        )}
      </div>

      {open && (
        <>
          <div className="panel__body chat__body" ref={bodyRef}>
            {messages.length === 0 && (
              <div className="panel__status">
                Ask about this diagram: clarify a source, flag a misleading figure,
                or request a change.
              </div>
            )}
            {messages.map((m) => (
              <ChatBubble key={m.id} message={m} onOpenRevision={onRevisionRef.current} />
            ))}
            {pendingId !== null && (
              <div className="bubble bubble--assistant bubble--pending">
                <div className="bubble__text">
                  <span className="typing">
                    <span />
                    <span />
                    <span />
                  </span>
                  working (this can take a minute)...
                </div>
              </div>
            )}
          </div>

          <div className="chat__compose">
            <textarea
              className="chat__input"
              placeholder="Ask about this diagram..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={2}
              disabled={busy}
            />
            <button
              type="button"
              className="chat__send"
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              aria-label="Send message"
            >
              <SendHorizontal size={18} />
            </button>
          </div>
        </>
      )}

      {confirmCancel && pendingId !== null && (
        <CancelConfirmModal
          onConfirm={() => {
            void cancelChat(pendingId).catch(() => {});
            setConfirmCancel(false);
          }}
          onClose={() => setConfirmCancel(false)}
        />
      )}
    </section>
  );
}

function ChatBubble({
  message,
  onOpenRevision,
}: {
  message: ChatMessage;
  onOpenRevision: (runId: number) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="bubble bubble--user">
        <div className="bubble__text">{message.content}</div>
      </div>
    );
  }
  // A pending assistant row is represented by the typing bubble, not its own
  // (empty-content) bubble — render nothing for it here.
  if (message.status === "pending") return null;

  const cancelled = message.error_detail === CANCELLED_DETAIL;
  if (message.status === "error" && !cancelled) {
    return (
      <div className="bubble bubble--error">
        <div className="bubble__role">error</div>
        <div className="bubble__text">
          {message.error_detail || message.content || "The reply did not complete."}
        </div>
      </div>
    );
  }
  const text = cancelled ? "Reply cancelled." : message.content;
  // Nothing to show (e.g. an empty done row replayed from history) → no bubble.
  if (!text && !message.revised_run_id) return null;
  return (
    <div className="bubble bubble--assistant">
      {text && (
        <div className="bubble__text">
          {cancelled ? text : <Markdown>{text}</Markdown>}
        </div>
      )}
      {message.revised_run_id && (
        <button
          type="button"
          className="chatpanel__revision"
          onClick={() => onOpenRevision(message.revised_run_id as number)}
        >
          View revised diagram →
        </button>
      )}
    </div>
  );
}
