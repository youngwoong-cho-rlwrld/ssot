import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";
import type { ModelOption } from "./types";

interface Props {
  value: string;
  options: ModelOption[];
  onChange: (id: string) => void;
  disabled?: boolean;
}

/**
 * Generation-model picker. Mirrors OpenClaw's ModelSwitcher trigger/listbox
 * (same `.model-switcher*` markup and classes), trimmed to a plain controlled
 * select — no provider/credential flow, since the model list is a fixed
 * backend allowlist here.
 */
export function ModelSelect({ value, options, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the popover on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = options.find((m) => m.id === value);
  const label = current?.label ?? value;

  const choose = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div className="model-switcher" ref={rootRef}>
      <button
        type="button"
        className="model-switcher__btn"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title="Generation model"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Cpu size={15} />
        <span className="model-switcher__current">{label}</span>
        <ChevronDown size={13} />
      </button>

      {open && (
        <div className="model-switcher__pop" role="listbox">
          <ul className="model-switcher__list">
            {options.map((m) => (
              <li key={m.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={m.id === value}
                  className={`model-switcher__item${
                    m.id === value ? " model-switcher__item--active" : ""
                  }`}
                  onClick={() => choose(m.id)}
                >
                  <span className="model-switcher__check">
                    {m.id === value && <Check size={13} />}
                  </span>
                  <span className="model-switcher__name">{m.label}</span>
                  <span className="model-switcher__provider">{m.id}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
