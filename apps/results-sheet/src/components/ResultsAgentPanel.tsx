"use client";

import { IconChevronLeft, IconMessageCircle } from "@tabler/icons-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
} from "react";
import type {
  AgentConnectionStatus,
  AgentMessage,
  AgentModel,
} from "@/lib/agentTypes";
import { PanelResizeHandle } from "@ssot/ui/PanelResizeHandle";
import { Markdown } from "@ssot/ui/Markdown";
import { ModelSwitcher } from "@ssot/ui/ModelSwitcher";
import { resolveCatalog } from "@ssot/ui/models-catalog";
import { ChatSendIcon } from "@ssot/ui/ChatSendIcon";

type ResultsAgentPanelProps = {
  open: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  status: AgentConnectionStatus;
  statusDetail: string;
  models: AgentModel[];
  selectedModel: string;
  messages: AgentMessage[];
  pending: boolean;
  onResizeStart: (event: PointerEvent<HTMLButtonElement>) => void;
  onResizeBy: (deltaWidth: number) => void;
  onClose: () => void;
  onModelChange: (model: string) => void;
  onSend: (message: string) => void;
};

export function ResultsAgentPanel({
  open,
  width,
  minWidth,
  maxWidth,
  status,
  statusDetail,
  models,
  selectedModel,
  messages,
  pending,
  onResizeStart,
  onResizeBy,
  onClose,
  onModelChange,
  onSend,
}: ResultsAgentPanelProps) {
  const [value, setValue] = useState("");
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const isComposingRef = useRef(false);
  const pinnedToBottomRef = useRef(true);
  const showExamplePrompts = messages.length === 0;

  useEffect(() => {
    if (!open) setValue("");
    else pinnedToBottomRef.current = true;
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !pinnedToBottomRef.current) return;
    const frameId = window.requestAnimationFrame(() => {
      const element = messagesRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [messages, open, pending]);

  const submitMessage = () => {
    const message = value.trim();
    if (!message || pending) return;
    pinnedToBottomRef.current = true;
    setValue("");
    onSend(message);
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    submitMessage();
  };

  if (!open) return null;

  const panelStyle = {
    "--panel-width": `${width}px`,
    "--panel-min-width": `${minWidth}px`,
    "--panel-max-width": `${maxWidth}px`,
  } as CSSProperties;
  // Shared canonical catalog resolved against the daemon's live models, so the
  // list + order match model-diagram and openclaw exactly; daemon-exposed ids are
  // enabled (select via the daemon key), the rest disabled with a reason tooltip.
  const modelOptions = resolveCatalog(models);
  const noneEnabled = modelOptions.every((option) => option.disabled);
  const statusTitle = statusDetail ? `${status}: ${statusDetail}` : status;

  return (
    <aside className="agentPanel" style={panelStyle} aria-label="Results chat agent">
      <PanelResizeHandle
        side="right"
        label="Resize chat panel"
        value={width}
        min={minWidth}
        max={maxWidth}
        onPointerDown={onResizeStart}
        onResizeBy={onResizeBy}
      />
      <div className="panel__head vsection__head">
        <div className="vsection__toggle">
          <IconMessageCircle size={16} stroke={1.5} aria-hidden="true" />
          <h3 className="panel__title">Chat with agent</h3>
        </div>
        <button className="agentPanelClose" type="button" aria-label="Close agent panel" onClick={onClose}>
          <IconChevronLeft size={18} stroke={1.4} aria-hidden="true" />
        </button>
      </div>
      <div
        ref={messagesRef}
        className="panel__body chat__body"
        role="log"
        aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
        }}
      >
        {messages.map((message) => (
          <div key={message.id} className={`bubble bubble--${message.role}`}>
            {message.role === "system" && <div className="bubble__role">{message.role}</div>}
            <div className="bubble__text">
              <MarkdownMessage text={message.text} />
            </div>
          </div>
        ))}
        {pending && (
          <div className="bubble bubble--assistant bubble--pending" role="status" aria-label="Waiting for response">
            <div className="bubble__text">
              <span className="typing" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              working (this can take a minute)...
            </div>
          </div>
        )}
      </div>
      {showExamplePrompts && (
        <div className="agentExamplePrompts" aria-label="Example prompts">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              disabled={pending}
              onClick={() => {
                setValue("");
                onSend(prompt);
              }}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}
      <div className="chat__modelbar">
        <span
          className={`agentStatusDot agentStatusDot-${status}`}
          aria-hidden="true"
          title={statusTitle}
        />
        <ModelSwitcher
          title={statusTitle}
          value={selectedModel}
          options={modelOptions}
          disabled={pending || noneEnabled}
          onChange={onModelChange}
        />
      </div>
      <form className="chat__compose" onSubmit={handleSubmit}>
        <textarea
          className="chat__input"
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            isComposingRef.current = false;
            setValue(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              if (event.nativeEvent.isComposing || isComposingRef.current) return;
              event.preventDefault();
              submitMessage();
            }
          }}
          placeholder="Ask about results or change the table..."
          rows={2}
        />
        <button
          className="chat__send"
          type="submit"
          aria-label="Send message"
          disabled={pending || value.trim().length === 0}
        >
          <ChatSendIcon size={18} />
        </button>
      </form>
    </aside>
  );
}

const EXAMPLE_PROMPTS = [
  "Show me the result of poc1",
  "Color the heuristics experiments in blue",
  "Sort by Total average, descending. Then open the chart",
];

// Thin wrapper over the shared @ssot/ui <Markdown> (react-markdown + remark-gfm),
// which replaced the hand-rolled block/inline parser flagged for dedup. Same `.md`
// scope, so the visual result is unchanged (now with full GFM support).
function MarkdownMessage({ text }: { text: string }) {
  return <Markdown>{text}</Markdown>;
}
