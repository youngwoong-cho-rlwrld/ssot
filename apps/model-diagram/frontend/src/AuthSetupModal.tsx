import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Modal } from "@ssot/ui/Modal";
import type { ModelFamily } from "./types";

// Copyable command line. Full browser-driven OAuth for these CLIs isn't feasible,
// so we show the exact commands to run on the backend host + a re-check.
function CodeLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };
  return (
    <div className="authsetup__cmd">
      <code>{text}</code>
      <button
        type="button"
        className="ssot-icon-btn"
        onClick={copy}
        title="Copy"
        aria-label="Copy command"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

export function AuthSetupModal({
  hostname,
  family,
  rechecking,
  onRecheck,
  onClose,
}: {
  hostname: string | null;
  family: ModelFamily | undefined;
  rechecking: boolean;
  onRecheck: () => void;
  onClose: () => void;
}) {
  const host = hostname || "the backend host";
  return (
    <Modal
      title="Set up authentication"
      ariaLabel="Set up authentication"
      className="modal--confirm"
      onClose={onClose}
    >
      <div className="modal__body authsetup">
        <p>
          The agent runtime must be authenticated on <strong>{host}</strong>, the
          machine the backend runs on (not this browser).
        </p>
        {family === "codex" ? (
          <>
            <p>Log in to the Codex CLI there:</p>
            <CodeLine text="codex login" />
          </>
        ) : (
          <>
            <p>Either log in to the Claude Code CLI there:</p>
            <CodeLine text="claude" />
            <p>
              or set an API key in the repo <code>.env</code> and restart the
              backend:
            </p>
            <CodeLine text="ANTHROPIC_API_KEY=sk-…" />
          </>
        )}
        <p className="authsetup__note">Then re-check below.</p>
      </div>
      <div className="modal__foot">
        <button type="button" className="ssot-btn" onClick={onClose}>
          Close
        </button>
        <button
          type="button"
          className="ssot-btn ssot-btn-primary"
          onClick={onRecheck}
          disabled={rechecking}
        >
          {rechecking ? "Re-checking…" : "Re-check"}
        </button>
      </div>
    </Modal>
  );
}
