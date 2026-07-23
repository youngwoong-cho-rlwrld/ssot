// Relative-time formatters are shared across the session apps and live in
// @ssot/ui. `relativeTime` (ISO) replaces the former local `relativeTimeIso`.
export { relativeTimeMs, relativeTime } from "@ssot/ui/dates";

/** Message from a thrown value: Error.message, else String(value). */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * Eight random hex characters for a browser-created SSOT chat key.
 * ``crypto.randomUUID`` is unavailable when the portal is served over plain
 * HTTP on a non-local address. ``getRandomValues`` remains available there,
 * so fresh chats work on the dev server without weakening uniqueness.
 */
export function randomSessionSuffix(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().slice(0, 8);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

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
