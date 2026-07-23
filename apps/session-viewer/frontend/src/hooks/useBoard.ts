import { useCallback, useEffect, useRef, useState } from "react";
import { getBoard, putBoardNode } from "../api";
import type { BoardNode } from "../types";

interface UseBoardResult {
  board: Map<string, BoardNode>;
  loading: boolean;
  error: string | null;
  updateNode: (uid: string, partial: Partial<Omit<BoardNode, "uid">>) => void;
  removeNode: (uid: string) => void;
}

function defaultNode(uid: string): BoardNode {
  return { uid, x: 0, y: 0, color: null, starred: false, note: "" };
}

/**
 * Loads /api/board into a Map<uid, BoardNode>. updateNode applies the change
 * optimistically to local state and PUTs to the backend; the server response
 * (the full merged node) is then reconciled back into the map.
 */
export function useBoard(): UseBoardResult {
  const [board, setBoard] = useState<Map<string, BoardNode>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  // Per-uid write sequence so out-of-order PUT responses can't clobber newer
  // state: each updateNode bumps the uid's seq, and a late .then() bails if a
  // newer write has since been issued for that uid.
  const seqRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    (async () => {
      try {
        const nodes = await getBoard(controller.signal);
        if (!mounted.current) return;
        setBoard(new Map(nodes.map((n) => [n.uid, n])));
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (!mounted.current) return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted.current) setLoading(false);
      }
    })();
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);

  const updateNode = useCallback(
    (uid: string, partial: Partial<Omit<BoardNode, "uid">>) => {
      const seq = (seqRef.current.get(uid) ?? 0) + 1;
      seqRef.current.set(uid, seq);
      setBoard((prev) => {
        const next = new Map(prev);
        const existing = prev.get(uid) ?? defaultNode(uid);
        next.set(uid, { ...existing, ...partial });
        return next;
      });
      putBoardNode(uid, partial)
        .then((saved) => {
          if (!mounted.current) return;
          if (seqRef.current.get(uid) !== seq) return;
          setBoard((prev) => {
            const next = new Map(prev);
            next.set(uid, saved);
            return next;
          });
        })
        .catch((err) => {
          if (!mounted.current) return;
          setError(err instanceof Error ? err.message : String(err));
        });
    },
    [],
  );

  const removeNode = useCallback((uid: string) => {
    setBoard((prev) => {
      if (!prev.has(uid)) return prev;
      const next = new Map(prev);
      next.delete(uid);
      return next;
    });
  }, []);

  return { board, loading, error, updateNode, removeNode };
}
