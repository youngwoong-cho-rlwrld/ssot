// Shared date/time formatters for session UIs. Extracted from OpenClaw and
// session-viewer, which carried byte-identical copies.

/** Relative time from an epoch-ms timestamp: "just now", "5m ago", "3d ago". */
export function relativeTimeMs(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "unknown";
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 0) return "just now";
  if (diffSec < 45) return "just now";
  if (diffSec < 90) return "1m ago";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMon = Math.floor(diffDay / 30);
  if (diffMon < 12) return `${diffMon}mo ago`;
  return `${Math.floor(diffMon / 12)}y ago`;
}

/** Relative time from an ISO string. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? "unknown" : relativeTimeMs(t);
}

/** Absolute, human-readable timestamp for tooltips/headers, from an ISO string. */
export function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "unknown" : d.toLocaleString();
}
