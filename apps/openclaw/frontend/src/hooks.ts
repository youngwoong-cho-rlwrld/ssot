import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type DependencyList,
  type RefObject,
  type SetStateAction,
} from "react";
import { errMessage } from "./util";

/**
 * Runs `fn(signal)` immediately, then every `intervalMs`, self-scheduling so a
 * slow call never overlaps the next. Each tick gets a fresh AbortController; the
 * in-flight request is aborted and polling stops on unmount or when `deps`
 * change (which re-arms the loop).
 */
export function usePolling(
  fn: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  deps: DependencyList = [],
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    let controller: AbortController | null = null;
    let timer: number | null = null;
    const tick = async () => {
      controller = new AbortController();
      try {
        await fnRef.current(controller.signal);
      } finally {
        if (alive) timer = window.setTimeout(() => void tick(), intervalMs);
      }
    };
    void tick();
    return () => {
      alive = false;
      controller?.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps]);
}

interface AsyncData<T> {
  data: T | null;
  error: string | null;
  setData: Dispatch<SetStateAction<T | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  /** Re-fetch on demand (e.g. after a mutation); unmount-guarded. */
  reload: () => Promise<void>;
  /** Live mounted flag so callers can guard their own post-await state sets. */
  mounted: RefObject<boolean>;
}

/**
 * Fetches `fetcher(signal)` once on mount into `data`/`error`, aborting on
 * unmount. Exposes `reload` for post-mutation refreshes and the `mounted` ref
 * so a mutation handler can guard the extra state it sets after awaiting.
 */
export function useAsyncData<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
): AsyncData<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const runFetch = useCallback(async (signal: AbortSignal) => {
    try {
      const d = await fetcherRef.current(signal);
      if (mounted.current && !signal.aborted) {
        setData(d);
        setError(null);
      }
    } catch (err) {
      if (mounted.current && !signal.aborted) setError(errMessage(err));
    }
  }, []);

  const reload = useCallback(() => {
    const controller = new AbortController();
    return runFetch(controller.signal);
  }, [runFetch]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void runFetch(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [runFetch]);

  return { data, error, setData, setError, reload, mounted };
}
