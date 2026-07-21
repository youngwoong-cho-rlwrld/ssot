"use client";

import {
  IconChevronLeft,
  IconMessageCircle,
  IconSend,
} from "@tabler/icons-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import type {
  AgentConnectionStatus,
  AgentMessage,
  AgentModel,
} from "@/lib/agentTypes";
import { PanelResizeHandle } from "@/components/PanelResizeHandle";
import { SsotSelect, type SsotSelectOption } from "@ssot/ui/SsotSelect";

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
  const availableModels: SsotSelectOption[] = models
    .filter((model) => model.available)
    .map((model) => ({ value: model.key, label: model.name }));
  const modelOptions = availableModels.length > 0
    ? availableModels
    : [{ value: "", label: "No model" }];
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
      <div className="agentPanelHeader">
        <div className="agentPanelTitleGroup">
          <div className="agentPanelTitle">
            <IconMessageCircle size={16} stroke={1.5} aria-hidden="true" />
            <span>Chat</span>
          </div>
          <div className="agentModelControl" title={statusTitle}>
            <span className={`agentStatusDot agentStatusDot-${status}`} aria-hidden="true" />
            <SsotSelect
              className="compactSelect agentModelSelect"
              aria-label="Chat model"
              title={statusTitle}
              value={selectedModel}
              options={modelOptions}
              disabled={pending || availableModels.length === 0}
              onChange={onModelChange}
            />
          </div>
        </div>
        <button className="agentPanelClose" type="button" aria-label="Close agent panel" onClick={onClose}>
          <IconChevronLeft size={18} stroke={1.4} aria-hidden="true" />
        </button>
      </div>
      <div
        ref={messagesRef}
        className="agentMessages chat__body"
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
          rows={3}
        />
        <button
          className="chat__send"
          type="submit"
          aria-label="Send message"
          disabled={pending || value.trim().length === 0}
        >
          <IconSend size={18} stroke={1.5} aria-hidden="true" />
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

type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "code"; text: string };

function MarkdownMessage({ text }: { text: string }) {
  const blocks = parseMarkdownBlocks(text);

  return (
    <div className="md">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <pre key={index}>
              <code>{block.text}</code>
            </pre>
          );
        }
        if (block.type === "unordered-list") {
          return (
            <ul key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "ordered-list") {
          return (
            <ol key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInlineMarkdown(item)}</li>
              ))}
            </ol>
          );
        }
        return <p key={index}>{renderInlineMarkdown(block.text)}</p>;
      })}
    </div>
  );
}

function parseMarkdownBlocks(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (trimmed.startsWith("```")) {
      flushParagraph();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ type: "code", text: codeLines.join("\n") });
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      const items = [bullet[1] ?? ""];
      while (index + 1 < lines.length) {
        const next = (lines[index + 1] ?? "").match(/^\s*[-*]\s+(.+)$/);
        if (!next) break;
        items.push(next[1] ?? "");
        index += 1;
      }
      blocks.push({ type: "unordered-list", items });
      continue;
    }

    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      const items = [ordered[1] ?? ""];
      while (index + 1 < lines.length) {
        const next = (lines[index + 1] ?? "").match(/^\s*\d+[.)]\s+(.+)$/);
        if (!next) break;
        items.push(next[1] ?? "");
        index += 1;
      }
      blocks.push({ type: "ordered-list", items });
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  return blocks;
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const tokenPattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];

    if (token.startsWith("`")) {
      nodes.push(<code key={nodes.length}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={nodes.length}>{token.slice(2, -2)}</strong>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      if (link) {
        nodes.push(
          <a key={nodes.length} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
