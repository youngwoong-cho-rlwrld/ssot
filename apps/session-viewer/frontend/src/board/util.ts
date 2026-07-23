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

export { relativeTime, formatAbsolute } from "@ssot/ui/dates";
