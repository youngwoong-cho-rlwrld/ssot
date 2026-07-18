import type { Session } from "../types";

export type AgentFilter = "all" | "claude" | "codex";
export type DatePreset = "any" | "24h" | "7d" | "30d" | "custom";

export interface FilterState {
  q: string;
  agent: AgentFilter;
  project: string; // "" means all projects
  // Date filter on updated_at. "any" disables it; "custom" uses dateFrom/dateTo.
  datePreset: DatePreset;
  dateFrom: string; // YYYY-MM-DD (custom only)
  dateTo: string; // YYYY-MM-DD (custom only)
  // Message-count bounds; null = unbounded on that side.
  msgMin: number | null;
  msgMax: number | null;
}

export const initialFilterState: FilterState = {
  q: "",
  agent: "all",
  project: "",
  datePreset: "any",
  dateFrom: "",
  dateTo: "",
  msgMin: null,
  msgMax: null,
};

const DAY_MS = 24 * 60 * 60 * 1000;

function matchesQuery(s: Session, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    s.title.toLowerCase().includes(needle) ||
    (s.last_prompt?.toLowerCase().includes(needle) ?? false) ||
    s.project.toLowerCase().includes(needle)
  );
}

function withinDate(s: Session, filters: FilterState, now: number): boolean {
  if (filters.datePreset === "any") return true;
  const updated = new Date(s.updated_at).getTime();
  if (Number.isNaN(updated)) return false;

  switch (filters.datePreset) {
    case "24h":
      return now - updated <= DAY_MS;
    case "7d":
      return now - updated <= 7 * DAY_MS;
    case "30d":
      return now - updated <= 30 * DAY_MS;
    case "custom": {
      if (filters.dateFrom) {
        const from = new Date(`${filters.dateFrom}T00:00:00`).getTime();
        if (!Number.isNaN(from) && updated < from) return false;
      }
      if (filters.dateTo) {
        const to = new Date(`${filters.dateTo}T23:59:59.999`).getTime();
        if (!Number.isNaN(to) && updated > to) return false;
      }
      return true;
    }
    default:
      return true;
  }
}

/** Apply all client-side filters. */
export function filterSessions(
  sessions: Session[],
  filters: FilterState,
): Session[] {
  const now = Date.now();
  return sessions.filter((s) => {
    if (filters.agent !== "all" && s.agent !== filters.agent) return false;
    if (filters.project && s.project !== filters.project) return false;
    if (!matchesQuery(s, filters.q)) return false;
    if (!withinDate(s, filters, now)) return false;
    if (filters.msgMin != null && s.message_count < filters.msgMin) return false;
    if (filters.msgMax != null && s.message_count > filters.msgMax) return false;
    return true;
  });
}

/** Distinct project names present in the sessions, alphabetically sorted. */
export function projectsOf(sessions: Session[]): string[] {
  const set = new Set<string>();
  for (const s of sessions) set.add(s.project || "unknown");
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Largest message_count across sessions (upper bound for the range slider). */
export function maxMessagesOf(sessions: Session[]): number {
  return sessions.reduce((m, s) => Math.max(m, s.message_count), 0);
}

/**
 * Log-scaled mapping between a slider position (0..1) and a message count
 * (0..max). Message counts are heavily right-skewed (most sessions have a
 * handful of messages, a few have thousands), so a linear axis would pile
 * almost everything into the first bin. The log scale spreads the distribution
 * out like a price-range filter while staying exactly invertible.
 */
export function makeMsgScale(max: number) {
  const span = Math.log(max + 1);
  return {
    /** message count -> position in [0, 1] */
    toPos: (v: number) => (span <= 0 ? 0 : Math.log(v + 1) / span),
    /** position in [0, 1] -> message count in [0, max] */
    toValue: (p: number) => Math.round((max + 1) ** p - 1),
  };
}

/**
 * Distribution of message_count across `bins` buckets on the log scale above.
 * Used to draw the Airbnb-style histogram over the range slider.
 */
export function messageHistogram(
  sessions: Session[],
  bins: number,
  max: number,
): number[] {
  const out = new Array<number>(bins).fill(0);
  if (max <= 0) return out;
  const span = Math.log(max + 1);
  for (const s of sessions) {
    let idx = Math.floor((Math.log(s.message_count + 1) / span) * bins);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    out[idx]++;
  }
  return out;
}

/** How many non-search filters are active (for the search-bar badge). */
export function activeFilterCount(filters: FilterState): number {
  let n = 0;
  if (filters.agent !== "all") n++;
  if (filters.project) n++;
  if (filters.datePreset !== "any") n++;
  if (filters.msgMin != null || filters.msgMax != null) n++;
  return n;
}
