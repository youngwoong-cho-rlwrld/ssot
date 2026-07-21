import { useEffect, useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import { assistantReply, getTranscriptByKey, postChat } from "./api";
import { Markdown } from "./Markdown";
import { ToolCallView } from "@ssot/ui/ToolCallView";
import { ToolVisibilityToggle } from "./ToolVisibilityToggle";
import { usePersistedBool } from "./hooks";
import type { ToolCall, Turn } from "./types";
import { randomSessionSuffix } from "./util";

type ChatItem =
  | { kind: "msg"; role: "user" | "assistant" | "error"; text: string }
  | { kind: "tools"; calls: ToolCall[] };

interface ChatProps {
  agentId: string;
  // The bound session key, or null for a fresh unbound chat.
  boundSessionKey: string | null;
  boundLabel: string | null;
  newChatNonce: number;
  onTurnComplete: () => void;
}

function turnsToItems(turns: Turn[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const t of turns) {
    if ((t.role === "user" || t.role === "assistant") && t.text.trim()) {
      items.push({ kind: "msg", role: t.role, text: t.text });
    }
    if (t.tool_calls && t.tool_calls.length) {
      items.push({ kind: "tools", calls: t.tool_calls });
    }
  }
  return items;
}

export function Chat({
  agentId,
  boundSessionKey,
  boundLabel,
  newChatNonce,
  onTurnComplete,
}: ChatProps) {
  const [thread, setThread] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  // A fresh unbound chat's key is generated lazily on first send.
  const [localKey, setLocalKey] = useState<string | null>(null);
  const [showTools, toggleTools] = usePersistedBool("openclaw.showToolCalls.chat", false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const turnControllerRef = useRef<AbortController | null>(null);

  const effectiveKey = boundSessionKey ?? localKey;
  // Tracks the current effective key so an in-flight turn can detect a mid-flight
  // rebind and drop its stale reply.
  const boundKeyRef = useRef<string | null>(effectiveKey);
  useEffect(() => {
    boundKeyRef.current = boundSessionKey ?? localKey;
  }, [boundSessionKey, localKey]);

  useEffect(() => () => {
    turnControllerRef.current?.abort();
  }, []);

  // Rebind whenever the selected session changes, or New chat is pressed (nonce).
  // Loads history for a bound session; a fresh unbound chat starts empty.
  useEffect(() => {
    turnControllerRef.current?.abort();
    turnControllerRef.current = null;
    setLocalKey(null);
    setBusy(false);
    setThread([]);
    if (!boundSessionKey) {
      setLoadingHistory(false);
      return;
    }
    let alive = true;
    const controller = new AbortController();
    setLoadingHistory(true);
    getTranscriptByKey(agentId, boundSessionKey, controller.signal)
      .then((d) => {
        if (alive) setThread(turnsToItems(d.turns));
      })
      .catch(() => {
        // No transcript yet: start empty.
      })
      .finally(() => {
        if (alive) setLoadingHistory(false);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [agentId, boundSessionKey, newChatNonce]);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [thread, busy]);

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    // Resolve the key this turn targets, creating one lazily for a fresh chat.
    let turnKey = effectiveKey;
    if (!turnKey) {
      turnKey = `agent:main:ssot-chat-${randomSessionSuffix()}`;
      setLocalKey(turnKey);
      // Point the ref at the new key now so the reply-guard matches on return.
      boundKeyRef.current = turnKey;
    }
    setThread((t) => [...t, { kind: "msg", role: "user", text: message }]);
    setInput("");
    setBusy(true);
    const controller = new AbortController();
    turnControllerRef.current = controller;
    try {
      const res = await postChat(message, turnKey, undefined, controller.signal);
      const reply = assistantReply(res) || "(no reply)";
      // Drop the reply if the user switched sessions while it was in flight.
      if (boundKeyRef.current === turnKey) {
        setThread((t) => [...t, { kind: "msg", role: "assistant", text: reply }]);
      }
      onTurnComplete();
    } catch (err) {
      if (controller.signal.aborted) return;
      if (boundKeyRef.current === turnKey) {
        setThread((t) => [
          ...t,
          {
            kind: "msg",
            role: "error",
            text: err instanceof Error ? err.message : String(err),
          },
        ]);
      }
    } finally {
      if (turnControllerRef.current === controller) {
        turnControllerRef.current = null;
      }
      if (boundKeyRef.current === turnKey) setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <section className="panel chat">
      <div className="panel__head">
        <h2 className="panel__title">Chat</h2>
        <ToolVisibilityToggle
          visible={showTools}
          onToggle={toggleTools}
          context="chat"
        />
        <span className="chat__key" title={boundSessionKey ?? "new chat"}>
          {boundSessionKey ? boundLabel : "New chat"}
        </span>
      </div>

      <div className="panel__body chat__body" ref={bodyRef}>
        {loadingHistory && <div className="panel__status">Loading history...</div>}
        {!loadingHistory && thread.length === 0 && (
          <div className="panel__status">
            {boundSessionKey
              ? "No messages in this thread yet."
              : "Start a new chat"}
          </div>
        )}
        {thread.map((it, i) =>
          it.kind === "msg" ? (
            <div key={i} className={`bubble bubble--${it.role}`}>
              {it.role === "error" && <div className="bubble__role">error</div>}
              <div className="bubble__text">
                {it.role === "error" ? it.text : <Markdown>{it.text}</Markdown>}
              </div>
            </div>
          ) : showTools ? (
            <div key={i} className="bubble bubble--tool">
              {it.calls.map((tc, j) => (
                <ToolCallView key={j} call={tc} />
              ))}
            </div>
          ) : null,
        )}
        {busy && (
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
          placeholder="Message the agent..."
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
    </section>
  );
}
