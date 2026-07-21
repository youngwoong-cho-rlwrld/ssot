import { useEffect, useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import {
  filterSessions,
  initialFilterState,
  makeMsgScale,
  messageHistogram,
  type AgentFilter,
  type DatePreset,
  type FilterState,
} from "./filters";
import type { Session } from "../types";
import { SsotSelect } from "../SsotSelect";

interface FilterPanelProps {
  initial: FilterState;
  onApply: (next: FilterState) => void;
  onClose: () => void;
  projects: string[];
  sessions: Session[];
  maxMessages: number;
}

const AGENT_OPTIONS: { value: AgentFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "claude", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "openclaw", label: "OpenClaw" },
];

const DATE_OPTIONS: { value: DatePreset; label: string }[] = [
  { value: "any", label: "Any time" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "custom", label: "Custom" },
];

const HIST_BINS = 32;
const SLIDER_STEPS = 240;

export function FilterPanel({
  initial,
  onApply,
  onClose,
  projects,
  sessions,
  maxMessages,
}: FilterPanelProps) {
  // Local draft: edits stay here and are only committed on "Show results".
  const [draft, setDraft] = useState<FilterState>(initial);
  const set = (patch: Partial<FilterState>) =>
    setDraft((prev) => ({ ...prev, ...patch }));

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const previewCount = useMemo(
    () => filterSessions(sessions, draft).length,
    [sessions, draft],
  );

  const hist = useMemo(
    () => messageHistogram(sessions, HIST_BINS, maxMessages),
    [sessions, maxMessages],
  );
  const histMax = useMemo(() => Math.max(1, ...hist), [hist]);

  const hasRange = maxMessages > 0;
  const scale = useMemo(() => makeMsgScale(maxMessages), [maxMessages]);
  const lo = draft.msgMin ?? 0;
  const hi = draft.msgMax ?? maxMessages;

  const setMin = (v: number) => {
    const clamped = Math.min(Math.max(0, v), hi);
    set({ msgMin: clamped <= 0 ? null : clamped });
  };
  const setMax = (v: number) => {
    const clamped = Math.max(Math.min(maxMessages, v), lo);
    set({ msgMax: clamped >= maxMessages ? null : clamped });
  };

  // Slider works in log-scaled position space so the skewed distribution spreads
  // evenly across the track; values are converted back to real counts on change.
  const loPos = scale.toPos(lo);
  const hiPos = scale.toPos(hi);
  const loPct = loPos * 100;
  const hiPct = hiPos * 100;

  return (
    <>
      <div className="fp__scrim" onClick={onClose} />
      <div
        className="fp"
        role="dialog"
        aria-label="Filters"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="fp__head">
          <span className="fp__title">Filters</span>
          <button
            type="button"
            className="fp__x"
            onClick={onClose}
            aria-label="Close filters"
          >
            <X size={16} />
          </button>
        </div>

        <div className="fp__body">
          {/* Search */}
          <div className="fp-field">
            <span className="fp-field__label">Search</span>
            <div className="fp-search">
              <Search size={15} className="fp-search__icon" />
              <input
                autoFocus
                type="search"
                placeholder="Title, prompt, project…"
                value={draft.q}
                onChange={(e) => set({ q: e.target.value })}
                aria-label="Search sessions"
              />
            </div>
          </div>

          {/* Agent */}
          <div className="fp-field">
            <span className="fp-field__label">Agent</span>
            <div className="seg" role="group" aria-label="Agent filter">
              {AGENT_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`seg__btn${draft.agent === opt.value ? " seg__btn--on" : ""}`}
                  onClick={() => set({ agent: opt.value })}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Project */}
          <div className="fp-field">
            <span className="fp-field__label">Project</span>
            <SsotSelect
              aria-label="Project filter"
              value={draft.project}
              onChange={(value) => set({ project: value })}
              options={[
                { value: "", label: "All projects" },
                ...projects.map((p) => ({ value: p, label: p })),
              ]}
            />
          </div>

          <hr className="fp__rule" />

          {/* Date */}
          <div className="fp-field">
            <span className="fp-field__label">Date</span>
            <div className="fp-chips">
              {DATE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`fp-chip${draft.datePreset === opt.value ? " fp-chip--on" : ""}`}
                  onClick={() =>
                    set(
                      opt.value === "custom"
                        ? { datePreset: "custom" }
                        : { datePreset: opt.value, dateFrom: "", dateTo: "" },
                    )
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {draft.datePreset === "custom" && (
              <div className="fp-daterow">
                <label className="fp-date">
                  <span>From</span>
                  <input
                    type="date"
                    value={draft.dateFrom}
                    max={draft.dateTo || undefined}
                    onChange={(e) => set({ dateFrom: e.target.value })}
                  />
                </label>
                <label className="fp-date">
                  <span>To</span>
                  <input
                    type="date"
                    value={draft.dateTo}
                    min={draft.dateFrom || undefined}
                    onChange={(e) => set({ dateTo: e.target.value })}
                  />
                </label>
              </div>
            )}
          </div>

          <hr className="fp__rule" />

          {/* Messages */}
          <div className="fp-field">
            <span className="fp-field__label">Messages</span>
            {hasRange ? (
              <>
                <div className="fp-rangeval">
                  {lo}
                  {" – "}
                  {hi >= maxMessages ? `${maxMessages}+` : hi}
                </div>
                <div className="fp-hist" aria-hidden="true">
                  {hist.map((count, i) => {
                    const active =
                      i / HIST_BINS < hiPos && (i + 1) / HIST_BINS > loPos;
                    return (
                      <span
                        key={i}
                        className={`fp-hist__bar${active ? " fp-hist__bar--on" : ""}`}
                        style={{
                          height: `${count === 0 ? 0 : Math.max(8, (count / histMax) * 100)}%`,
                        }}
                      />
                    );
                  })}
                </div>
                <div className="fp-range">
                  <div className="fp-range__track" />
                  <div
                    className="fp-range__fill"
                    style={{ left: `${loPct}%`, right: `${100 - hiPct}%` }}
                  />
                  <input
                    type="range"
                    min={0}
                    max={SLIDER_STEPS}
                    value={Math.round(loPos * SLIDER_STEPS)}
                    onChange={(e) =>
                      setMin(scale.toValue(Number(e.target.value) / SLIDER_STEPS))
                    }
                    aria-label="Minimum messages"
                  />
                  <input
                    type="range"
                    min={0}
                    max={SLIDER_STEPS}
                    value={Math.round(hiPos * SLIDER_STEPS)}
                    onChange={(e) =>
                      setMax(scale.toValue(Number(e.target.value) / SLIDER_STEPS))
                    }
                    aria-label="Maximum messages"
                  />
                </div>
                <div className="fp-minmax">
                  <label className="fp-num">
                    <span>Min</span>
                    <input
                      type="number"
                      min={0}
                      max={hi}
                      value={draft.msgMin ?? ""}
                      placeholder="0"
                      onChange={(e) =>
                        setMin(e.target.value === "" ? 0 : Number(e.target.value))
                      }
                    />
                  </label>
                  <label className="fp-num">
                    <span>Max</span>
                    <input
                      type="number"
                      min={lo}
                      max={maxMessages}
                      value={draft.msgMax ?? ""}
                      placeholder={String(maxMessages)}
                      onChange={(e) =>
                        setMax(
                          e.target.value === ""
                            ? maxMessages
                            : Number(e.target.value),
                        )
                      }
                    />
                  </label>
                </div>
              </>
            ) : (
              <span className="fp-empty">No sessions to range over.</span>
            )}
          </div>
        </div>

        <div className="fp__foot">
          <button
            type="button"
            className="fp-clear"
            onClick={() => setDraft(initialFilterState)}
          >
            Clear all
          </button>
          <button
            type="button"
            className="fp-apply"
            onClick={() => {
              onApply(draft);
              onClose();
            }}
          >
            Show {previewCount} {previewCount === 1 ? "result" : "results"}
          </button>
        </div>
      </div>
    </>
  );
}
