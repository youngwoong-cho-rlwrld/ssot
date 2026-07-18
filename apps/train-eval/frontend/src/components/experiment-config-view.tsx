"use client";

import { type ReactNode } from "react";
import { Code, LayoutList } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/loading-state";
import { parseSimpleYaml, type YamlValue } from "@/lib/simple-yaml";

export type ConfigViewMode = "ui" | "code";

/** UI/Code toggle for the experiment file viewers. Matches the app's slate
 *  palette and dark-mode approach. */
export function ConfigViewToggle({
  mode,
  onChange,
}: {
  mode: ConfigViewMode;
  onChange: (mode: ConfigViewMode) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-slate-200 p-0.5 dark:border-slate-800">
      <ToggleButton
        active={mode === "ui"}
        onClick={() => onChange("ui")}
        icon={<LayoutList className="h-3.5 w-3.5" />}
        label="UI"
      />
      <ToggleButton
        active={mode === "code"}
        onClick={() => onChange("code")}
        icon={<Code className="h-3.5 w-3.5" />}
        label="Code"
      />
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "bg-[var(--ssot-accent)] text-white"
          : "text-[var(--ssot-text-soft)] hover:text-[var(--ssot-accent)]",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/** Names assigned in a config.sh (scalars and arrays), e.g. `MODEL_ID=`,
 *  `export DATA_DIR=`, `TASKS=(`. The server parse sources the file with
 *  `declare -p`, which also dumps the inherited shell environment; we scope the
 *  view to names the file itself authors so bash internals (BASH_*, PWD, …) and
 *  ambient env vars don't leak in. */
function authoredNames(raw: string): Set<string> {
  const names = new Set<string>();
  const re = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)=/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) names.add(m[1]);
  return names;
}

/** Read-only key-value view of a parsed config.sh: scalar vars first, then each
 *  array var as a named block of rows. Renders generically off whatever vars /
 *  arrays the file authors — no dependency on specific variable names. */
export function ConfigKeyValueView({
  raw,
  vars,
  arrays,
}: {
  raw: string;
  vars: Record<string, string>;
  arrays: Record<string, string[]>;
}) {
  const authored = authoredNames(raw);
  const scalarKeys = Object.keys(vars).filter((k) => authored.has(k)).sort();
  const arrayKeys = Object.keys(arrays).filter((k) => authored.has(k)).sort();
  if (scalarKeys.length === 0 && arrayKeys.length === 0) {
    return <EmptyState message="No variables parsed from config.sh." />;
  }
  return (
    <div className="space-y-5">
      {scalarKeys.length > 0 && (
        <div className="divide-y divide-slate-100 dark:divide-slate-900">
          {scalarKeys.map((key) => (
            <div
              key={key}
              className="grid grid-cols-[minmax(10rem,16rem)_1fr] items-start gap-3 py-1.5 text-xs"
            >
              <code className="break-all font-mono text-slate-600 dark:text-slate-300">{key}</code>
              <code className="break-all font-mono text-[var(--ssot-text-soft)]">
                {vars[key] || <span className="text-slate-400">(empty)</span>}
              </code>
            </div>
          ))}
        </div>
      )}
      {arrayKeys.map((key) => (
        <div key={key} className="space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--ssot-text-soft)]">
            <code className="font-mono normal-case tracking-normal text-slate-600 dark:text-slate-300">
              {key}
            </code>
            <span className="text-slate-400">
              {arrays[key].length} {arrays[key].length === 1 ? "item" : "items"}
            </span>
          </div>
          {arrays[key].length === 0 ? (
            <p className="text-xs text-slate-400">(empty)</p>
          ) : (
            <ol className="space-y-1">
              {arrays[key].map((item, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 rounded border border-[var(--ssot-border)] bg-[var(--ssot-surface-muted)] px-2 py-1 text-xs"
                >
                  <span className="select-none font-mono text-slate-400">{i}</span>
                  <code className="min-w-0 break-all font-mono text-slate-600 dark:text-slate-300">
                    {item}
                  </code>
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </div>
  );
}

/** Read-only structured view of a YAML file. Parses the block subset the
 *  experiment YAML files use; if the content falls outside that subset it
 *  renders a notice so the caller's Code view stays the source of truth. */
export function YamlTreeView({ text }: { text: string }) {
  let parsed: YamlValue;
  try {
    parsed = parseSimpleYaml(text);
  } catch {
    return (
      <EmptyState message="Could not render a structured view of this file. Switch to Code to see the raw YAML." />
    );
  }
  return (
    <div className="text-xs">
      <YamlNode value={parsed} />
    </div>
  );
}

function YamlNode({ value }: { value: YamlValue }) {
  if (value === null || typeof value !== "object") {
    return <YamlScalar value={value} />;
  }
  const entries: Array<[string, YamlValue]> = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
  if (entries.length === 0) {
    return <span className="font-mono text-slate-400">{Array.isArray(value) ? "[]" : "{}"}</span>;
  }
  return (
    <div className="space-y-1 border-l border-slate-200 pl-3 dark:border-slate-800">
      {entries.map(([key, child]) => {
        const nested = child !== null && typeof child === "object";
        return (
          <div key={key} className={nested ? "space-y-1" : "flex flex-wrap items-baseline gap-x-2"}>
            <code
              className={cn(
                "font-mono",
                Array.isArray(value) ? "text-slate-400" : "text-slate-600 dark:text-slate-300",
              )}
            >
              {key}
              {nested ? "" : ":"}
            </code>
            {nested ? <YamlNode value={child} /> : <YamlScalar value={child} />}
          </div>
        );
      })}
    </div>
  );
}

function YamlScalar({ value }: { value: YamlValue }) {
  if (value === null) {
    return <code className="font-mono text-slate-400">null</code>;
  }
  if (typeof value === "boolean") {
    return <code className="font-mono text-amber-600 dark:text-amber-400">{String(value)}</code>;
  }
  if (typeof value === "number") {
    return <code className="font-mono text-[var(--ssot-accent)]">{String(value)}</code>;
  }
  return <code className="break-all font-mono text-[var(--ssot-text-soft)]">{String(value)}</code>;
}
