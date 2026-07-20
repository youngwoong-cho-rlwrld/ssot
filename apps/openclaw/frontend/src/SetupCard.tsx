import { Terminal } from "lucide-react";

const STEPS: { cmd: string; note: string }[] = [
  { cmd: "npm install -g openclaw", note: "Install the OpenClaw CLI." },
  { cmd: "openclaw onboard", note: "Run first-time setup (accounts, workspace)." },
  { cmd: "openclaw gateway", note: "Start the gateway this portal talks to." },
];

export function SetupCard() {
  return (
    <div className="setup">
      <div className="setup__card">
        <div className="setup__icon">
          <Terminal size={28} />
        </div>
        <h1 className="setup__title">OpenClaw is not installed on this machine</h1>
        <p className="setup__lead">
          This portal drives the local <code>openclaw</code> CLI, which was not
          found. Install it and start the gateway, then reload this page.
        </p>
        <ol className="setup__steps">
          {STEPS.map((s) => (
            <li key={s.cmd}>
              <code className="setup__cmd">{s.cmd}</code>
              <span className="setup__note">{s.note}</span>
            </li>
          ))}
        </ol>
        <p className="setup__foot">
          Already installed? Make sure <code>openclaw</code> is on the backend's
          PATH (set <code>OPENCLAW_BIN</code> if it lives elsewhere).
        </p>
      </div>
    </div>
  );
}
