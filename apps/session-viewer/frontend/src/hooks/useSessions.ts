import { useCallback, useEffect, useRef, useState } from "react";
import { getSessions } from "../api";
import type { Session } from "../types";

const POLL_MS = 5000;

interface UseSessionsResult {
  sessions: Session[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  removeLocal: (uid: string) => void;
}

// Fields that affect rendering or filtering. If none changed, the old Session
// object can be reused so downstream memos / react-flow nodes stay referentially
// stable and don't re-render.
function sameSession(a: Session, b: Session): boolean {
  return (
    a.updated_at === b.updated_at &&
    a.message_count === b.message_count &&
    a.active === b.active &&
    a.title === b.title &&
    a.last_prompt === b.last_prompt &&
    a.project === b.project &&
    a.agent === b.agent
  );
}

/**
 * Merge a freshly-fetched list into the previous one, preserving object
 * identity for unchanged sessions and returning the SAME array reference when
 * nothing changed at all. This is what stops the 5s poll from re-rendering the
 * entire board when the underlying data is identical.
 */
function reconcile(prev: Session[], next: Session[]): Session[] {
  const byUid = new Map(prev.map((s) => [s.uid, s]));
  let changed = prev.length !== next.length;
  const merged = next.map((s, i) => {
    const old = byUid.get(s.uid);
    if (!old) {
      changed = true;
      return s;
    }
    if (prev[i]?.uid !== s.uid) changed = true; // order shifted
    if (sameSession(old, s)) return old; // reuse ref
    changed = true;
    return s;
  });
  return changed ? merged : prev;
}

/**
 * Polls GET /api/sessions every 5s. We intentionally fetch the full unfiltered
 * list and apply search/agent/project/view filtering client-side, so that the
 * board can react instantly to filter changes without a round-trip and so the
 * 5s poll never thrashes when the user is typing in the search box.
 */
export function useSessions(): UseSessionsResult {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bump to force an immediate out-of-band refresh.
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // Optimistically drop a session locally (e.g. right after deleting it) so the
  // card disappears immediately; the next poll reconciles with the server.
  const removeLocal = useCallback((uid: string) => {
    setSessions((prev) => prev.filter((s) => s.uid !== uid));
  }, []);

  useEffect(() => {
    mounted.current = true;
    let controller = new AbortController();

    const load = async () => {
      controller.abort();
      controller = new AbortController();
      try {
        const data = await getSessions({ signal: controller.signal });
        if (!mounted.current) return;
        setSessions((prev) => reconcile(prev, data));
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted.current) setLoading(false);
      }
    };

    void load();
    const interval = window.setInterval(() => void load(), POLL_MS);

    return () => {
      mounted.current = false;
      controller.abort();
      window.clearInterval(interval);
    };
  }, [tick]);

  return { sessions, loading, error, refresh, removeLocal };
}
