import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { StatusBar } from "./StatusBar";
import { SessionList } from "./SessionList";
import { TranscriptPanel } from "./TranscriptPanel";
import { LogFeed } from "./LogFeed";
import { Chat } from "./Chat";
import { InstructionsPanel } from "./InstructionsPanel";
import { SetupCard } from "./SetupCard";
import { ApiError, getStatus } from "./api";
import type { OpenClawSession } from "./types";

const PROBE_MS = 10_000;

export default function App() {
  const [selected, setSelected] = useState<OpenClawSession | null>(null);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  // Whether the openclaw CLI is present. A status probe returning the
  // "cli_missing" kind means the binary isn't installed, so we replace the
  // whole app with a setup card. Any other error (gateway down) keeps the
  // normal layout, where the status bar shows its banner.
  const [cliMissing, setCliMissing] = useState(false);
  const portalUrl = import.meta.env.VITE_SSOT_PORTAL_URL ?? "/";

  useEffect(() => {
    let alive = true;
    let controller: AbortController | null = null;
    const probe = () => {
      controller?.abort();
      controller = new AbortController();
      getStatus(controller.signal)
        .then(() => alive && setCliMissing(false))
        .catch((err) => {
          if (controller?.signal.aborted || !alive) return;
          setCliMissing(err instanceof ApiError && err.kind === "cli_missing");
        });
    };
    probe();
    const id = window.setInterval(probe, PROBE_MS);
    return () => {
      alive = false;
      controller?.abort();
      window.clearInterval(id);
    };
  }, []);

  if (cliMissing) {
    return (
      <div className="app">
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
    <div className="app">
      <header className="ssot-header">
        <a className="ssot-brand" href={portalUrl}>
          SSOT
        </a>
        <span className="ssot-sep">/</span>
        <span className="ssot-app-name">OpenClaw</span>
        <span className="ssot-header-spacer"></span>
        <button
          type="button"
          className="header-btn"
          onClick={() => setInstructionsOpen(true)}
          title="Edit global instructions"
        >
          <FileText size={15} />
          Instructions
        </button>
        <ssot-theme-toggle></ssot-theme-toggle>
        <ssot-user></ssot-user>
      </header>

      <StatusBar />

      <main className="app__content">
        <div className="col col--activity">
          <SessionList
            selectedKey={selected?.key ?? null}
            onSelect={setSelected}
            onDeleted={(key) =>
              setSelected((cur) => (cur?.key === key ? null : cur))
            }
          />
          <LogFeed />
        </div>

        <div className="col col--transcript">
          <TranscriptPanel
            agentId={selected?.agentId ?? null}
            sessionId={selected?.sessionId ?? null}
            sessionKey={selected?.key ?? null}
            kind={selected?.kind ?? null}
          />
        </div>

        <div className="col col--chat">
          <Chat />
        </div>
      </main>

      {instructionsOpen && (
        <InstructionsPanel onClose={() => setInstructionsOpen(false)} />
      )}
    </div>
  );
}
