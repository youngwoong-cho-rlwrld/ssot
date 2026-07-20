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
export function relativeTimeIso(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? "unknown" : relativeTimeMs(t);
}

/** Absolute, human-readable timestamp for tooltips. */
export function formatAbsoluteMs(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "unknown";
  return new Date(ms).toLocaleString();
}

/** Compact token count: 1234 -> "1.2k", 1200000 -> "1.2M". */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "-";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// A session is "active" when its file changed within the last 5 minutes.
export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Humanize a raw session key into a friendly label, keeping the meaningful
 * part (slack channel, cron id tail) and dropping the "agent:<id>:" prefix.
 * The full key should still be shown in a tooltip by the caller.
 */
export function sessionLabel(key: string): string {
  const parts = key.split(":");
  const rest = parts.slice(2); // drop "agent:<agentId>"
  if (rest.length === 0) return key;
  const head = rest[0];
  if (head === "slack") {
    const chan = rest[2]; // slack:channel:<id>[:thread:<ts>]
    if (rest.includes("thread")) return chan ? `Slack thread · #${chan}` : "Slack thread";
    return chan ? `Slack · #${chan}` : "Slack";
  }
  if (head === "cron") {
    const id = rest[1] ?? "";
    return `Cron · ${id.slice(0, 8)}`.trimEnd();
  }
  if (rest.length === 1) {
    if (head === "main") return "Main agent";
    if (head === "ssot-chat") return "Main chat";
    return head;
  }
  return rest.join(":");
}
