import type { Session } from "../types";

export const CARD_WIDTH = 220;
export const CARD_HEIGHT = 150;
const GAP_X = 36;
const GAP_Y = 30;
const CELL_W = CARD_WIDTH + GAP_X;
const CELL_H = CARD_HEIGHT + GAP_Y;

export interface Point {
  x: number;
  y: number;
}

/**
 * Place sessions that lack a saved BoardNode into a compact grid.
 *
 * Cards are ordered by project (alphabetical, stable across reloads) and then
 * newest-first within a project, so same-project cards sit next to each other.
 * The grid wraps at a column count chosen to stay roughly rectangular, so
 * fitView shows readable cards rather than one very tall per-project column.
 */
export function computeAutoLayout(sessions: Session[]): Record<string, Point> {
  const ordered = [...sessions].sort((a, b) => {
    const pa = a.project || "unknown";
    const pb = b.project || "unknown";
    if (pa !== pb) return pa.localeCompare(pb);
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });

  const cols = Math.max(4, Math.round(Math.sqrt(ordered.length * 1.7)));

  const result: Record<string, Point> = {};
  ordered.forEach((session, i) => {
    result[session.uid] = {
      x: (i % cols) * CELL_W,
      y: Math.floor(i / cols) * CELL_H,
    };
  });
  return result;
}
