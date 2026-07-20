import { useEffect, useState } from "react";
import { Trash2, X } from "lucide-react";
import { cleanupSessions, getCleanupPreview } from "../api";
import type { CleanupCategory, CleanupPreview } from "../types";

interface CleanupPanelProps {
  onClose: () => void;
  onCleaned: () => void;
  onHighlight: (uids: string[]) => void;
}

const OPTIONS: {
  id: CleanupCategory;
  label: string;
  description: string;
}[] = [
  { id: "system", label: "System", description: "Cron sessions" },
  { id: "old", label: "Old", description: "Older than 14 days" },
  { id: "short", label: "Short", description: "Less than 10 chats" },
];

export function CleanupPanel({
  onClose,
  onCleaned,
  onHighlight,
}: CleanupPanelProps) {
  const [selected, setSelected] = useState<CleanupCategory[]>([]);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [cleaning, setCleaning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    if (selected.length === 0) onHighlight([]);
    getCleanupPreview(selected, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        setPreview(next);
        onHighlight(next.affected_uids);
        setError(null);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          onHighlight([]);
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selected, revision, onHighlight]);

  useEffect(
    () => () => {
      onHighlight([]);
    },
    [onHighlight],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (category: CleanupCategory) => {
    setSelected((current) =>
      current.includes(category)
        ? current.filter((value) => value !== category)
        : [...current, category],
    );
  };

  const onCleanup = async () => {
    if (selected.length === 0 || !preview?.affected) return;
    setCleaning(true);
    setError(null);
    try {
      const result = await cleanupSessions(selected, preview.affected_uids);
      onCleaned();
      if (result.failed === 0) {
        onClose();
        return;
      }
      setError(
        `${result.deleted} permanently deleted; ${result.failed} could not be cleaned up.`,
      );
      setRevision((value) => value + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(false);
    }
  };

  const affected = preview?.affected ?? 0;

  return (
    <>
      <div className="fp__scrim" onClick={onClose} />
      <div
        className="fp cleanup-panel"
        role="dialog"
        aria-label="Clean up sessions"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="fp__head">
          <span className="fp__title">Clean up sessions</span>
          <button
            type="button"
            className="fp__x"
            onClick={onClose}
            aria-label="Close cleanup"
          >
            <X size={16} />
          </button>
        </div>

        <div className="fp__body cleanup-panel__body">
          <div className="cleanup-options" role="group" aria-label="Session groups">
            {OPTIONS.map((option) => {
              const checked = selected.includes(option.id);
              return (
                <label
                  key={option.id}
                  className={`cleanup-option${checked ? " cleanup-option--on" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={cleaning}
                    onChange={() => toggle(option.id)}
                  />
                  <span className="cleanup-option__copy">
                    <span className="cleanup-option__label">{option.label}</span>
                    <span className="cleanup-option__description">
                      {option.description}
                    </span>
                  </span>
                  <span className="cleanup-option__count">
                    {preview?.counts[option.id] ?? "–"}
                  </span>
                </label>
              );
            })}
          </div>
          {error && (
            <div className="cleanup-panel__error" role="alert">
              {error}
            </div>
          )}
        </div>

        <div className="fp__foot">
          <button
            type="button"
            className="fp-clear"
            onClick={() => setSelected([])}
            disabled={selected.length === 0 || cleaning}
          >
            Clear all
          </button>
          <button
            type="button"
            className="fp-apply cleanup-apply"
            onClick={onCleanup}
            disabled={loading || cleaning || selected.length === 0 || affected === 0}
          >
            <Trash2 size={14} />
            {cleaning ? "Cleaning up..." : `Delete ${affected} permanently`}
          </button>
        </div>
      </div>
    </>
  );
}
