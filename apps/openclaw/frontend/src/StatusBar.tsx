import { useEffect, useState } from "react";
import { Activity, Circle } from "lucide-react";
import { getStatus } from "./api";
import { ModelSwitcher } from "./ModelSwitcher";
import { HeartbeatControl } from "./HeartbeatControl";
import type { StatusResponse } from "./types";

const POLL_MS = 10_000;

function Stat({
  icon,
  label,
  value,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="stat" title={title}>
      <span className="stat__icon">{icon}</span>
      <span className="stat__body">
        <span className="stat__label">{label}</span>
        <span className="stat__value">{value}</span>
      </span>
    </div>
  );
}

export function StatusBar() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let controller: AbortController | null = null;

    const tick = () => {
      controller?.abort();
      controller = new AbortController();
      getStatus(controller.signal)
        .then((s) => {
          if (alive) {
            setStatus(s);
            setError(null);
          }
        })
        .catch((err) => {
          if (controller?.signal.aborted) return;
          if (alive) setError(err instanceof Error ? err.message : String(err));
        });
    };

    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      controller?.abort();
      window.clearInterval(id);
    };
  }, []);

  const healthy = !error && status != null;
  const tasks = status?.tasks;

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
          {tasks && (
            <Stat
              icon={<Activity size={15} />}
              label="Tasks"
              value={`${tasks.active ?? 0} active`}
              title={`${tasks.total ?? 0} total · ${tasks.failures ?? 0} failures`}
            />
          )}
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
