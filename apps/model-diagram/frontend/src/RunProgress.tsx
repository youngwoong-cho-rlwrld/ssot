import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CircleAlert,
  Loader2,
} from "lucide-react";
import { getRun, openRunEvents } from "./api";
import type { Stage } from "./types";

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
};

function errorHint(kind: string): string | null {
  if (kind === "not_a_model_root")
    return "That directory isn’t a single model codebase — pick another path.";
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
}

interface TerminalError {
  kind: string;
  detail: string;
}

export function RunProgress({ runId, onDone, onBack, embedded = false }: Props) {
  // null until we learn from the run record whether a paper is attached; that
  // decides whether the paper stages appear in the checklist.
  const [hasPaper, setHasPaper] = useState<boolean | null>(null);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [failed, setFailed] = useState<TerminalError | null>(null);
  const [mismatch, setMismatch] = useState<string | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // Prime from the run record: learn paper status, and short-circuit if the run
  // already reached a terminal state before we opened the stream.
  useEffect(() => {
    let alive = true;
    getRun(runId)
      .then((run) => {
        if (!alive) return;
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
      })
      .catch(() => {
        if (alive) setHasPaper(false);
      });
    return () => {
      alive = false;
    };
  }, [runId]);

  // Live stage stream. openRunEvents replays persisted stages then tails live
  // events, closing itself on any terminal frame.
  useEffect(() => {
    const close = openRunEvents(runId, {
      onStage: (stage, stageDetail) => {
        // A paper stage arriving is proof a paper is attached, whatever the
        // run record said — never filter out the stage we're currently in.
        if (PAPER_STAGES.has(stage as Stage)) setHasPaper(true);
        setCurrentStage(stage);
        setDetail(stageDetail || null);
      },
      onWarning: (kind, warnDetail) => {
        if (kind === "paper_mismatch") setMismatch(warnDetail);
      },
      onDone: () => onDoneRef.current(),
      onError: (kind, errDetail) => setFailed({ kind, detail: errDetail }),
    });
    return close;
  }, [runId]);

  const stages = useMemo(
    () => BASE_ORDER.filter((s) => hasPaper !== false || !PAPER_STAGES.has(s)),
    [hasPaper],
  );

  const currentIndex = currentStage
    ? stages.indexOf(currentStage as Stage)
    : -1;

  const body = (
    <div className="panel__body runprog__body">
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
                  {active && detail && (
                    <span className="stage__detail">{detail}</span>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {!failed && currentStage === null && (
          <p className="runprog__waiting">Starting analysis…</p>
        )}
      </div>
  );

  if (embedded) {
    return <div className="runprog runprog--embedded">{body}</div>;
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
      </div>

      {body}
    </section>
  );
}
