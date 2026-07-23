import { useCallback, useEffect, useRef, useState } from "react";
import { Save } from "lucide-react";
import { Modal } from "@ssot/ui/Modal";
import { getInstructions, getInstruction, putInstruction } from "./api";
import { errMessage } from "./util";
import type { InstructionFile } from "./types";

// These files are injected into every agent turn's system prompt, read fresh
// each turn, so a save takes effect from the next turn with no restart.
const APPLIES_NOTE = "Applies from the next agent turn (no restart needed).";

// One-line orientation per file so the user knows what belongs where.
const HINTS: Record<string, string> = {
  "AGENTS.md":
    "Main behavioral instructions: put common rules like styling guides here.",
  "SOUL.md": "Personality and voice.",
  "IDENTITY.md": "Who the agent is.",
  "USER.md": "About the human.",
  "TOOLS.md": "Local tool notes.",
  "HEARTBEAT.md":
    "Runs on scheduled heartbeat turns only, intentionally comments-only; active text here executes every heartbeat.",
};

export function InstructionsPanel({ onClose }: { onClose: () => void }) {
  const [files, setFiles] = useState<InstructionFile[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const dirty = content !== savedContent;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Load the file list once, then open the first file.
  useEffect(() => {
    const controller = new AbortController();
    getInstructions(controller.signal)
      .then((list) => {
        setFiles(list.files);
        setActive((cur) => cur ?? list.files[0]?.name ?? null);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(errMessage(err));
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  // Load the active file's content whenever the selection changes.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setNote(null);
    getInstruction(active, controller.signal)
      .then((detail) => {
        setContent(detail.content);
        setSavedContent(detail.content);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(errMessage(err));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active]);

  const selectFile = (name: string) => {
    if (name === active) return;
    if (dirtyRef.current && !window.confirm("Discard unsaved changes?")) return;
    setActive(name);
  };

  const save = async () => {
    if (!active || saving || !dirty) return;
    setSaving(true);
    setError(null);
    setNote(null);
    try {
      const res = await putInstruction(active, content);
      setSavedContent(content);
      setFiles((prev) =>
        prev.map((f) =>
          f.name === active
            ? { ...f, exists: res.exists, size: res.size, mtime: res.mtime }
            : f,
        ),
      );
      setNote(`Saved${res.backed_up ? " (previous version backed up)" : ""}. ${APPLIES_NOTE}`);
    } catch (err) {
      setError(errMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const requestClose = useCallback(() => {
    if (dirtyRef.current && !window.confirm("Discard unsaved changes?")) return;
    onClose();
  }, [onClose]);

  return (
    <Modal
      title="Global instructions"
      ariaLabel="Global instructions"
      className="instructions"
      onClose={requestClose}
    >
        <div className="instructions__tabs" role="tablist">
          {files.map((f) => (
            <button
              key={f.name}
              type="button"
              role="tab"
              aria-selected={f.name === active}
              className={`instructions__tab${
                f.name === active ? " instructions__tab--active" : ""
              }`}
              onClick={() => selectFile(f.name)}
              title={f.mtime ? `edited ${new Date(f.mtime).toLocaleString()}` : "not created yet"}
            >
              {f.name}
              {f.name === active && dirty ? " *" : ""}
            </button>
          ))}
        </div>

        {active && HINTS[active] && (
          <p className="instructions__hint">{HINTS[active]}</p>
        )}

        <textarea
          className="instructions__editor"
          value={content}
          spellCheck={false}
          disabled={loading || !active}
          onChange={(e) => setContent(e.target.value)}
          placeholder={loading ? "Loading..." : "This file is empty."}
        />

        <div className="instructions__foot">
          <span className="instructions__msg">
            {error ? (
              <span className="instructions__err">{error}</span>
            ) : note ? (
              note
            ) : (
              APPLIES_NOTE
            )}
          </span>
          <button
            type="button"
            className="ssot-btn ssot-btn-primary instructions__save"
            onClick={() => void save()}
            disabled={saving || loading || !dirty}
          >
            <Save size={15} />
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
    </Modal>
  );
}
