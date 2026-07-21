import { Circle, FileText } from "lucide-react";
import { ModelSwitcher } from "./ModelSwitcher";
import { HeartbeatControl } from "./HeartbeatControl";
import type { StatusResponse } from "./types";

type StatusBarProps = {
  status: StatusResponse | null;
  error: string | null;
  onOpenInstructions: () => void;
};

export function StatusBar({ status, error, onOpenInstructions }: StatusBarProps) {
  const healthy = !error && status != null;

  return (
    <div className={`statusbar${error ? " statusbar--err" : ""}`}>
      <div className="statusbar__health">
        <Circle
          size={10}
          className={`dot ${healthy ? "dot--ok" : "dot--bad"}`}
          fill="currentColor"
        />
        <span className="statusbar__title">
          {error
            ? "Gateway unreachable"
            : `OpenClaw ${status?.runtimeVersion ?? ""}`.trim()}
        </span>
      </div>

      <div className="statusbar__stats">
        {!error && status && (
          <>
            <ModelSwitcher />
            <HeartbeatControl />
          </>
        )}
        <button
          type="button"
          className="statusbar__instructions"
          onClick={onOpenInstructions}
          title="Edit global instructions"
        >
          <FileText size={15} />
          Instructions
        </button>
      </div>

      {error && (
        <div className="statusbar__msg">
          {error}
          <span className="statusbar__hint">
            {" "}
            — is the gateway running? (<code>openclaw gateway</code>)
          </span>
        </div>
      )}
    </div>
  );
}
