import { Ban } from "lucide-react";
import { Modal } from "@ssot/ui/Modal";

// A thin confirm wrapper over the shared @ssot/ui <Modal> (overlay + head + close,
// backdrop/Escape dismissal). Styling lives in @ssot/theme/modal.css.
export function CancelConfirmModal({
  onConfirm,
  onClose,
  busy = false,
}: {
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <Modal title="Cancel run?" ariaLabel="Cancel run" className="modal--confirm" onClose={onClose}>
      <div className="modal__body">
        <p>
          This stops the analysis and marks the run cancelled. It can’t be undone,
          so you’d need to start a new run.
        </p>
      </div>
      <div className="modal__foot">
        <button type="button" className="ssot-btn" onClick={onClose} disabled={busy}>
          Keep running
        </button>
        <button
          type="button"
          className="ssot-btn ssot-btn-primary"
          onClick={onConfirm}
          disabled={busy}
        >
          <Ban size={14} /> Cancel run
        </button>
      </div>
    </Modal>
  );
}
