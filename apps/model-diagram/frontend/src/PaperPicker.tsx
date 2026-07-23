import { Loader2, Upload, X } from "lucide-react";
import type { RefObject } from "react";

// Paper-source mode. "keep" only applies to re-provision (inherit the anchor run's
// paper); the New-diagram form uses the "none" | "url" | "pdf" subset.
export type PaperMode = "keep" | "none" | "url" | "pdf";

interface PaperPickerProps {
  // Segmented options in render order, each with its display label. Callers pass a
  // subset of PaperMode and supply the wording (the re-provision "Keep" label even
  // depends on whether a paper is currently attached).
  options: { value: PaperMode; label: string }[];
  mode: PaperMode;
  onSelect: (mode: PaperMode) => void;
  paperUrl: string;
  onPaperUrlChange: (value: string) => void;
  // The URL input's class differs by layout (stacked field vs. inline row).
  urlClassName?: string;
  // Distinct <input>/<label> id so two pickers on a page don't collide.
  pdfInputId: string;
  pdf: { name: string; pages?: number } | null;
  uploading: boolean;
  onPickPdf: (file: File | undefined) => void;
  onClearPdf: () => void;
  fileInputRef: RefObject<HTMLInputElement>;
  // Show the "N pp" page count beside a picked PDF (New-diagram only).
  showPages?: boolean;
}

// The paper-source picker shared by the New-diagram form and the viewer's
// re-provision form: a segmented URL/PDF/none(/keep) control plus the conditional
// URL input and PDF file button. The surrounding field label and error live in the
// caller so each form keeps its own chrome.
export function PaperPicker({
  options,
  mode,
  onSelect,
  paperUrl,
  onPaperUrlChange,
  urlClassName = "ssot-input",
  pdfInputId,
  pdf,
  uploading,
  onPickPdf,
  onClearPdf,
  fileInputRef,
  showPages = false,
}: PaperPickerProps) {
  return (
    <>
      <div className="ssot-seg" role="tablist" aria-label="Paper source">
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={mode === opt.value}
            className={`ssot-seg__btn${
              mode === opt.value ? " ssot-seg__btn--on" : ""
            }`}
            onClick={() => onSelect(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {mode === "url" && (
        <input
          className={urlClassName}
          type="url"
          value={paperUrl}
          onChange={(e) => onPaperUrlChange(e.target.value)}
          placeholder="https://arxiv.org/abs/…"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
      )}

      {mode === "pdf" && (
        <div className="newdiag__pdf">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            className="ssot-sr-only"
            id={pdfInputId}
            onChange={(e) => void onPickPdf(e.target.files?.[0])}
          />
          <label htmlFor={pdfInputId} className="ssot-btn newdiag__pdf-btn">
            {uploading ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Upload size={14} />
            )}
            {pdf ? pdf.name : "Choose PDF…"}
          </label>
          {pdf && (
            <>
              {showPages && pdf.pages != null && (
                <span className="newdiag__pdf-pages">{pdf.pages} pp</span>
              )}
              <button
                type="button"
                className="ssot-icon-btn"
                onClick={onClearPdf}
                title="Clear file"
                aria-label="Clear file"
              >
                <X size={14} />
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
