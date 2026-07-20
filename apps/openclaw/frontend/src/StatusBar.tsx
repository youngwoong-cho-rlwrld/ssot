import { Circle } from "lucide-react";
import { ModelSwitcher } from "./ModelSwitcher";
import { HeartbeatControl } from "./HeartbeatControl";
import type { StatusResponse } from "./types";

type StatusBarProps = {
  status: StatusResponse | null;
  error: string | null;
};

export function StatusBar({ status, error }: StatusBarProps) {
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

      {!error && status && (
        <div className="statusbar__stats">
          <ModelSwitcher />
          <HeartbeatControl />
        </div>
      )}

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
