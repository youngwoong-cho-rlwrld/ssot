import { useState } from "react";
import { Search, LayoutGrid } from "lucide-react";
import { FilterPanel } from "./FilterPanel";
import { activeFilterCount, type FilterState } from "./filters";
import type { Session } from "../types";

interface ToolbarProps {
  filters: FilterState;
  onApply: (next: FilterState) => void;
  projects: string[];
  sessions: Session[];
  maxMessages: number;
}

const AGENT_LABEL: Record<FilterState["agent"], string> = {
  all: "All agents",
  claude: "Claude",
  codex: "Codex",
};

const DATE_LABEL: Record<FilterState["datePreset"], string> = {
  any: "Any time",
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  custom: "Custom range",
};

export function Toolbar({
  filters,
  onApply,
  projects,
  sessions,
  maxMessages,
}: ToolbarProps) {
  const [open, setOpen] = useState(false);
  const activeCount = activeFilterCount(filters);

  return (
    <header className="toolbar">
      <div className="toolbar__brand">
        <LayoutGrid size={18} />
        <span>Session Board</span>
      </div>

      <div className="searchbar-wrap">
        <button
          type="button"
          className="searchbar"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <span className="searchbar__seg searchbar__seg--main">
            {filters.q || "Search sessions"}
          </span>
          <span className="searchbar__div" />
          <span className="searchbar__seg">{AGENT_LABEL[filters.agent]}</span>
          <span className="searchbar__div" />
          <span className="searchbar__seg searchbar__seg--soft">
            {DATE_LABEL[filters.datePreset]}
          </span>
          <span className="searchbar__go">
            <Search size={15} />
            {activeCount > 0 && (
              <span className="searchbar__badge">{activeCount}</span>
            )}
          </span>
        </button>

        {open && (
          <FilterPanel
            initial={filters}
            onApply={onApply}
            onClose={() => setOpen(false)}
            projects={projects}
            sessions={sessions}
            maxMessages={maxMessages}
          />
        )}
      </div>
    </header>
  );
}
