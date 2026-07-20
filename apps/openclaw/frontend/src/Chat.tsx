import { useEffect, useRef, useState } from "react";
import { SendHorizontal } from "lucide-react";
import { assistantReply, postChat } from "./api";

// A stable session key gives the chat continuity across turns. Verified against
// the live CLI (`openclaw agent --json -m ... --session-key agent:main:ssot-chat`).
const SESSION_KEY = "agent:main:ssot-chat";

interface ChatMessage {
  role: "user" | "assistant" | "error";
  text: string;
}

export function Chat() {
  const [thread, setThread] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [thread, busy]);

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setThread((t) => [...t, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    try {
      const res = await postChat(message, SESSION_KEY);
      const reply = assistantReply(res) || "(no reply)";
      setThread((t) => [...t, { role: "assistant", text: reply }]);
    } catch (err) {
      setThread((t) => [
        ...t,
        { role: "error", text: err instanceof Error ? err.message : String(err) },
      ]);
    } finally {
      setBusy(false);
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
        <span className="chat__key" title={SESSION_KEY}>
          Main agent
        </span>
      </div>

      <div className="panel__body chat__body" ref={bodyRef}>
        {thread.length === 0 && (
          <div className="panel__status">
            Send a message to the main agent (runs locally, one turn).
          </div>
        )}
        {thread.map((m, i) => (
          <div key={i} className={`bubble bubble--${m.role}`}>
            <div className="bubble__role">{m.role}</div>
            <div className="bubble__text">{m.text}</div>
          </div>
        ))}
        {busy && (
          <div className="bubble bubble--assistant bubble--pending">
            <div className="bubble__role">assistant</div>
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
