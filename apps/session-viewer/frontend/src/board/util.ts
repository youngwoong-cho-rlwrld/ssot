import type { Agent } from "../types";

/** Stable 32-bit-ish hash from a string (FNV-1a variant). */
export function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Return an unsigned int.
  return h >>> 0;
}

/**
 * Stable small rotation (degrees) derived from the uid hash, so each sticky
 * note has a consistent slight tilt across renders. Range roughly [-3, 3].
 */
export function rotationFor(uid: string): number {
  const h = hashString(uid);
  return ((h % 600) / 100) - 3;
}

/** Default sticky-note background per agent when no custom color is set. */
export function defaultColorFor(agent: Agent): string {
  if (agent === "claude") return "#fdf0d5";
  if (agent === "openclaw") return "#e3f5e1";
  return "#e7f0ff";
}

/** Relative time string like "just now", "5m ago", "2h ago", "3d ago". */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const diffSec = Math.floor((Date.now() - then) / 1000);
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
  const diffYr = Math.floor(diffMon / 12);
  return `${diffYr}y ago`;
}

/** Absolute, human-readable timestamp for tooltips/headers. */
export function formatAbsolute(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return d.toLocaleString();
}
