import { useEffect, useState } from "react";
import { StatusBar } from "./StatusBar";
import { SessionList } from "./SessionList";
import { TranscriptPanel } from "./TranscriptPanel";
import { LogFeed } from "./LogFeed";
import { Chat } from "./Chat";
import { InstructionsPanel } from "./InstructionsPanel";
import { SetupCard } from "./SetupCard";
import { ApiError, getStatus } from "./api";
import { sessionLabel } from "./util";
import type { OpenClawSession, StatusResponse } from "./types";

const PROBE_MS = 10_000;

export default function App() {
  // The single main pane is driven by the selected session: a DIRECT session
  // (or no selection) shows the CHAT view bound to it; group/cron show the
  // read-only TRANSCRIPT view. A nonce forces a fresh chat even when already
  // unbound, and a token refreshes the session list after a chat turn.
  const [selected, setSelected] = useState<OpenClawSession | null>(null);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [newChatNonce, setNewChatNonce] = useState(0);
  const [sessionsReloadToken, setSessionsReloadToken] = useState(0);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  // Whether the openclaw CLI is present. A status probe returning the
  // "cli_missing" kind means the binary isn't installed, so we replace the
  // whole app with a setup card. Any other error (gateway down) keeps the
  // normal layout, where the status bar shows its banner.
  const [cliMissing, setCliMissing] = useState(false);
  const portalUrl = import.meta.env.VITE_SSOT_PORTAL_URL ?? "/";

  // New chat: clear any selection and reset the pane to a fresh empty chat.
  const startNewChat = () => {
    setSelected(null);
    setNewChatNonce((n) => n + 1);
  };

  // direct session (or nothing selected) => chat; group/cron => transcript.
  const chatMode = selected === null || selected.kind === "direct";
  const boundKey = selected?.kind === "direct" ? selected.key : null;

  useEffect(() => {
    let alive = true;
    let controller: AbortController | null = null;
    let timer: number | null = null;
    const probe = async () => {
      const requestController = new AbortController();
      controller = requestController;
      try {
        const nextStatus = await getStatus(requestController.signal);
        if (!alive) return;
        setStatus(nextStatus);
        setStatusError(null);
        setCliMissing(false);
      } catch (err) {
        if (requestController.signal.aborted || !alive) return;
        setStatusError(err instanceof Error ? err.message : String(err));
        setCliMissing(err instanceof ApiError && err.kind === "cli_missing");
      } finally {
        if (alive) timer = window.setTimeout(() => void probe(), PROBE_MS);
      }
    };
    void probe();
    return () => {
      alive = false;
      controller?.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  if (cliMissing) {
    return (
      <div className="ssot-app app">
        <header className="ssot-header">
          <a className="ssot-brand" href={portalUrl}>
            SSOT
          </a>
          <span className="ssot-sep">/</span>
          <span className="ssot-app-name">OpenClaw</span>
          <span className="ssot-header-spacer"></span>
          <ssot-theme-toggle></ssot-theme-toggle>
          <ssot-user></ssot-user>
        </header>
        <SetupCard />
      </div>
    );
  }

  return (
    <div className="ssot-app app">
      <header className="ssot-header">
        <a className="ssot-brand" href={portalUrl}>
          SSOT
        </a>
        <span className="ssot-sep">/</span>
        <span className="ssot-app-name">OpenClaw</span>
        <span className="ssot-header-spacer"></span>
        <ssot-theme-toggle></ssot-theme-toggle>
        <ssot-user></ssot-user>
      </header>

      <StatusBar
        status={status}
        error={statusError}
        onOpenInstructions={() => setInstructionsOpen(true)}
      />

      <main className="app__content">
        <div className="col col--activity">
          <SessionList
            selectedKey={selected?.key ?? null}
            onSelect={setSelected}
            onNewChat={startNewChat}
            reloadToken={sessionsReloadToken}
            onDeleted={(key) =>
              setSelected((cur) => (cur?.key === key ? null : cur))
            }
          />
          <LogFeed />
        </div>

        <div className="col col--main">
          {chatMode ? (
            <Chat
              agentId={selected?.agentId ?? "main"}
              boundSessionKey={boundKey}
              boundLabel={boundKey ? sessionLabel(boundKey) : null}
              newChatNonce={newChatNonce}
              onTurnComplete={() => setSessionsReloadToken((n) => n + 1)}
            />
          ) : (
            <TranscriptPanel
              agentId={selected!.agentId}
              sessionId={selected!.sessionId}
              sessionKey={selected!.key}
              kind={selected!.kind}
            />
          )}
        </div>
      </main>

      {instructionsOpen && (
        <InstructionsPanel onClose={() => setInstructionsOpen(false)} />
      )}
    </div>
  );
}
