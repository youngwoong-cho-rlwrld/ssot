"use client";

import {
  IconChevronLeft,
  IconMessageCircle,
  IconSend,
  IconSettings,
  IconX,
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
import type { AgentConfig, AgentConnectionStatus, AgentMessage } from "@/lib/agentTypes";
import { PanelResizeHandle } from "@/components/PanelResizeHandle";

type ResultsAgentPanelProps = {
  open: boolean;
  width: number;
  minWidth: number;
  maxWidth: number;
  status: AgentConnectionStatus;
  statusDetail: string;
  messages: AgentMessage[];
  pending: boolean;
  onResizeStart: (event: PointerEvent<HTMLButtonElement>) => void;
  onResizeBy: (deltaWidth: number) => void;
  onClose: () => void;
  onOpenConfig: () => void;
  onSend: (message: string) => void;
};

type AgentConfigModalProps = {
  open: boolean;
  status: AgentConnectionStatus;
  statusDetail: string;
  config: AgentConfig;
  onClose: () => void;
  onSave: (config: AgentConfig) => void;
};

export function ResultsAgentPanel({
  open,
  width,
  minWidth,
  maxWidth,
  status,
  statusDetail,
  messages,
  pending,
  onResizeStart,
  onResizeBy,
  onClose,
  onOpenConfig,
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
          <button
            className="agentPanelStatusButton"
            type="button"
            aria-label={`Configure agent, currently ${status}`}
            title={statusDetail ? `${status}: ${statusDetail}` : status}
            onClick={onOpenConfig}
          >
            <span className={`agentStatusDot agentStatusDot-${status}`} />
            <span>{status}</span>
          </button>
        </div>
        <button className="agentPanelClose" type="button" aria-label="Close agent panel" onClick={onClose}>
          <IconChevronLeft size={18} stroke={1.4} aria-hidden="true" />
        </button>
      </div>
      <div
        ref={messagesRef}
        className="agentMessages"
        role="log"
        aria-live="polite"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
        }}
      >
        {messages.length === 0 ? (
          null
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`agentMessage agentMessage-${message.role}`}>
              <div className="agentMessageRole">{message.role}</div>
              <MarkdownMessage text={message.text} />
            </div>
          ))
        )}
        {pending && (
          <div className="agentLoading" role="status" aria-label="Waiting for response">
            <span className="agentLoadingSpinner" aria-hidden="true" />
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
      <form className="agentInputBar" onSubmit={handleSubmit}>
        <textarea
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
          className="agentSendButton"
          type="submit"
          aria-label="Send message"
          disabled={pending || value.trim().length === 0}
        >
          <IconSend size={16} stroke={1.5} aria-hidden="true" />
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

const AGENT_START_COMMAND =
  "AGENT_TOKEN=\"$(openssl rand -hex 32)\"; export AGENT_TOKEN; printf 'Agent token: %s\\n' \"$AGENT_TOKEN\"; APP_DIR=\"$PWD\" sh -lc 'tmux new-session -d -s results-agent -n chat \"cd \\\"$APP_DIR\\\" && claude\" && tmux split-window -h -t results-agent:0 \"cd \\\"$APP_DIR\\\" && AGENT_TOKEN=\\\"$AGENT_TOKEN\\\" AGENT_TMUX_TARGET=results-agent:0.0 npm run agent\" && tmux select-pane -t results-agent:0.0 && tmux attach -t results-agent'";

export function AgentConfigModal({
  open,
  status,
  statusDetail,
  config,
  onClose,
  onSave,
}: AgentConfigModalProps) {
  const [agentUrl, setAgentUrl] = useState(config.agentUrl);
  const [token, setToken] = useState(config.token);

  useEffect(() => {
    if (!open) return;
    setAgentUrl(config.agentUrl);
    setToken(config.token);
  }, [config, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  return (
    <div
      className="agentModalBackdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="agentModal" role="dialog" aria-modal="true" aria-labelledby="agent-config-title">
        <div className="agentModalHeader">
          <div className="agentModalTitle" id="agent-config-title">
            <IconSettings size={17} stroke={1.5} aria-hidden="true" />
            <span>Configure Agent</span>
          </div>
          <button className="agentPanelClose" type="button" aria-label="Close" onClick={onClose}>
            <IconX size={18} stroke={1.4} aria-hidden="true" />
          </button>
        </div>
        <div className="agentModalStatus">
          <span className={`agentStatusDot agentStatusDot-${status}`} />
          <span>{status}</span>
        </div>
        {statusDetail && <div className={`agentModalDetail agentModalDetail-${status}`}>{statusDetail}</div>}
        <div className="agentModalHelp">
          <ol>
            <li>Move to the directory where results-sheet-viewer is installed.</li>
            <li>Run this command. It opens tmux with Claude in pane 0 and the agent server in pane 1.</li>
            <li>Paste the same token into the Agent token field below.</li>
          </ol>
          <code>{AGENT_START_COMMAND}</code>
        </div>
        <label className="agentConfigField">
          <span>Agent URL</span>
          <input
            value={agentUrl}
            onChange={(event) => setAgentUrl(event.currentTarget.value)}
            placeholder="http://<agent-host>:3011"
          />
        </label>
        <label className="agentConfigField">
          <span>Agent token</span>
          <input
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
            placeholder="AGENT_TOKEN"
            type="password"
          />
        </label>
        <div className="agentModalActions">
          <button className="agentModalButton agentModalButtonSubtle" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="agentModalButton agentModalButtonPrimary"
            type="button"
            onClick={() => onSave({ agentUrl: agentUrl.trim(), token: token.trim() })}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

type MarkdownBlock =
  | { type: "paragraph"; text: string }
  | { type: "unordered-list"; items: string[] }
  | { type: "ordered-list"; items: string[] }
  | { type: "code"; text: string };

function MarkdownMessage({ text }: { text: string }) {
  const blocks = parseMarkdownBlocks(text);

  return (
    <div className="agentMarkdown">
      {blocks.map((block, index) => {
        if (block.type === "code") {
          return (
            <pre key={index} className="agentMarkdownCode">
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
