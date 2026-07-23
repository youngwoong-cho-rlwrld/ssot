import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Check,
  CircleAlert,
  Loader2,
  Terminal,
} from "lucide-react";
import { watchRun } from "./lib/watch-run";
import type { Stage } from "./types";

// Cap the agent-output pane so a long run cannot grow the DOM without bound; the
// backend already keeps only the most recent lines, and older ones aren't useful
// once scrolled past.
const OUTPUT_DOM_CAP = 500;

export const STAGE_LABEL: Record<Stage, string> = {
  inspecting_root: "Inspecting model root",
  pinning_commit: "Pinning commit",
  mapping_pipeline: "Mapping the pipeline",
  locating_sources: "Locating sources",
  verifying_lines: "Verifying line references",
  reading_paper: "Reading the paper",
  cross_checking_paper: "Cross-checking against the paper",
  laying_out: "Laying out the diagram",
  finalizing: "Finalizing",
};

const BASE_ORDER: Stage[] = [
  "inspecting_root",
  "pinning_commit",
  "mapping_pipeline",
  "locating_sources",
  "verifying_lines",
  "reading_paper",
  "cross_checking_paper",
  "laying_out",
  "finalizing",
];

const PAPER_STAGES = new Set<Stage>(["reading_paper", "cross_checking_paper"]);

export const ERROR_TITLE: Record<string, string> = {
  broken_path: "Path unreachable",
  broken_paper: "Paper unreadable",
  not_a_model_root: "Not a model root",
  agent_failure: "Analysis failed",
  credentials_not_configured: "Agent credentials not configured",
  cancelled: "Analysis cancelled",
};

function errorHint(kind: string): string | null {
  if (kind === "not_a_model_root")
    return "That directory isn’t a single model codebase. Pick another path.";
  if (kind === "credentials_not_configured")
    return "Set ANTHROPIC_API_KEY in the repo .env and try again.";
  return null;
}

interface Props {
  runId: number;
  onDone: () => void;
  onBack: () => void;
  // When embedded (e.g. inside the Viewer for a still-running run), the outer
  // panel header is dropped — the host supplies its own chrome — and the stage
  // checklist fills the available space.
  embedded?: boolean;
  // Controlled output-pane state: when the host supplies these (the Viewer, whose
  // header owns the toggle), RunProgress renders no toggle of its own and reflects
  // the host's open state. Omitted → RunProgress owns the toggle itself (standalone).
  outputOpen?: boolean;
  onOutputToggle?: () => void;
}

interface TerminalError {
  kind: string;
  detail: string;
}

export function RunProgress({
  runId,
  onDone,
  onBack,
  embedded = false,
  outputOpen,
  onOutputToggle,
}: Props) {
  // null until we learn from the run record whether a paper is attached; that
  // decides whether the paper stages appear in the checklist.
  const [hasPaper, setHasPaper] = useState<boolean | null>(null);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [failed, setFailed] = useState<TerminalError | null>(null);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const [internalShowOutput, setInternalShowOutput] = useState(false);
  const [output, setOutput] = useState<string[]>([]);
  const outputRef = useRef<HTMLPreElement>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // The output pane is host-controlled when the Viewer passes onOutputToggle
  // (its header owns the toggle); otherwise RunProgress owns it (standalone).
  const controlledOutput = onOutputToggle !== undefined;
  const showOutput = controlledOutput ? !!outputOpen : internalShowOutput;
  const toggleOutput = () =>
    controlledOutput ? onOutputToggle() : setInternalShowOutput((v) => !v);

  // Prime from the run record (learn paper status, surface a terminal state
  // reached before we connected), then tail the live stage stream, which replays
  // persisted stages and closes itself on any terminal frame. The shared watchRun
  // core drives both halves.
  useEffect(() => {
    const close = watchRun(runId, {
      onPrime: (run) => {
        setHasPaper(run.has_paper);
        if (run.paper_status === "mismatch") setMismatch(run.paper_warning ?? "");
        if (run.status === "done") {
          onDoneRef.current();
        } else if (run.status === "error") {
          setFailed({
            kind: run.error_kind ?? "agent_failure",
            detail: run.error_detail ?? "The analysis did not complete.",
          });
        }
      },
      onPrimeError: () => setHasPaper(false),
      onStage: (stage) => {
        // A paper stage arriving is proof a paper is attached, whatever the
        // run record said — never filter out the stage we're currently in.
        if (PAPER_STAGES.has(stage as Stage)) setHasPaper(true);
        setCurrentStage(stage);
      },
      onWarning: (kind, warnDetail) => {
        if (kind === "paper_mismatch") setMismatch(warnDetail);
      },
      onLog: (_seq, line) => {
        setOutput((prev) => {
          const next = prev.length >= OUTPUT_DOM_CAP ? prev.slice(1) : prev.slice();
          next.push(line);
          return next;
        });
      },
      onDone: () => onDoneRef.current(),
      onError: (kind, errDetail) => setFailed({ kind, detail: errDetail }),
    });
    return close;
  }, [runId]);

  // Reset the output buffer when switching runs (the stream replays the new run's
  // lines from the DB on connect). The host resets its own controlled open-state.
  useEffect(() => {
    setOutput([]);
    setInternalShowOutput(false);
  }, [runId]);

  // Keep the pane pinned to the latest line while it's open.
  useEffect(() => {
    if (showOutput && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output, showOutput]);

  const stages = useMemo(
    () => BASE_ORDER.filter((s) => hasPaper !== false || !PAPER_STAGES.has(s)),
    [hasPaper],
  );

  const currentIndex = currentStage
    ? stages.indexOf(currentStage as Stage)
    : -1;

  // The stages checklist + notices — the left column in split mode, and the whole
  // body otherwise.
  const stagePane = (
    <>
      {mismatch !== null && (
        <div className="notice notice--warn">
          <AlertTriangle size={15} />
          <div>
            <strong>Paper did not match the code.</strong>
            <p>
              {mismatch ||
                "Continuing from the code only; paper-cited numbers are omitted."}
            </p>
          </div>
        </div>
      )}

      {failed ? (
        failed.kind === "cancelled" ? (
          <div className="notice notice--muted">
            <Ban size={15} />
            <div>
              <strong>Analysis cancelled</strong>
              <p>{failed.detail || "This run was cancelled."}</p>
              <button type="button" className="ssot-btn" onClick={onBack}>
                Back to diagrams
              </button>
            </div>
          </div>
        ) : (
          <div className="notice notice--err">
            <CircleAlert size={15} />
            <div>
              <strong>{ERROR_TITLE[failed.kind] ?? "Analysis failed"}</strong>
              <p>{failed.detail}</p>
              {errorHint(failed.kind) && (
                <p className="notice__hint">{errorHint(failed.kind)}</p>
              )}
              <button type="button" className="ssot-btn" onClick={onBack}>
                Back to diagrams
              </button>
            </div>
          </div>
        )
      ) : (
        <ol className="stages">
          {stages.map((stage, i) => {
            const done = currentIndex > i;
            const active = currentIndex === i;
            const state = done ? "done" : active ? "active" : "todo";
            return (
              <li key={stage} className={`stage stage--${state}`}>
                <span className="stage__marker">
                  {done ? (
                    <Check size={13} />
                  ) : active ? (
                    <Loader2 size={13} className="spin" />
                  ) : (
                    <span className="stage__dot" />
                  )}
                </span>
                <span className="stage__label">{STAGE_LABEL[stage]}</span>
              </li>
            );
          })}
        </ol>
      )}

      {!failed && currentStage === null && (
        <p className="runprog__waiting">Starting analysis…</p>
      )}
    </>
  );

  // Own toggle, rendered only when uncontrolled (standalone). When the Viewer
  // controls the pane, its header renders the toggle instead. One icon button
  // opens AND closes (pressed/active state, OpenClaw tool-toggle grammar).
  const outputToggle = controlledOutput ? null : (
    <button
      type="button"
      className={`ssot-icon-btn${showOutput ? " ssot-icon-btn--on" : ""}`}
      onClick={toggleOutput}
      title={showOutput ? "Hide agent output" : "Show agent output"}
      aria-label={showOutput ? "Hide agent output" : "Show agent output"}
      aria-pressed={showOutput}
    >
      <Terminal size={15} />
    </button>
  );

  // The right-hand OUTPUT panel — a proper .panel with its own head, like
  // OpenClaw's side columns. No close button here: the single top-right toggle
  // owns open/close.
  const outputPanel = (
    <section className="panel runprog__output-panel">
      <div className="panel__head">
        <Terminal size={14} className="runprog__output-icon" />
        <h3 className="panel__title">Agent output</h3>
        {output.length > 0 && <span className="panel__count">{output.length}</span>}
      </div>
      <pre ref={outputRef} className="panel__body runprog__output" aria-label="Agent output">
        {output.length === 0 ? "Waiting for agent output…" : output.join("\n")}
      </pre>
    </section>
  );

  // When the output is shown, the content becomes a two-column split (stages |
  // output) that fills the height and stacks vertically on narrow widths; when
  // hidden, it is the classic single centered column.
  const content = showOutput ? (
    <div className="runprog__split">
      <div className="runprog__pane runprog__pane--stages">
        <div className="panel__body runprog__body">{stagePane}</div>
      </div>
      {outputPanel}
    </div>
  ) : (
    <div className="panel__body runprog__body">{stagePane}</div>
  );

  if (embedded) {
    // No panel head here (the Viewer supplies its own chrome, incl. the cancel
    // control), so the output toggle rides in a top-right actions bar.
    return (
      <div className="runprog runprog--embedded">
        {outputToggle && (
          <div className="runprog__embedded-actions">{outputToggle}</div>
        )}
        {content}
      </div>
    );
  }

  return (
    <section className="panel runprog">
      <div className="panel__head">
        <button
          type="button"
          className="ssot-icon-btn"
          onClick={onBack}
          title="Back"
          aria-label="Back to diagrams"
        >
          <ArrowLeft size={15} />
        </button>
        <h2 className="panel__title">
          {failed ? "Analysis stopped" : "Generating diagram"}
        </h2>
        {outputToggle && <span className="runprog__head-spacer" />}
        {outputToggle}
      </div>

      {content}
    </section>
  );
}
