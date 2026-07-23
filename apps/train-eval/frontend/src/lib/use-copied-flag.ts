"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Boolean "copied" flag that auto-resets after `resetMs`, with the pending
 * timer cleared on unmount so a late reset never fires on an unmounted button.
 */
export function useCopiedFlag(resetMs = 1500): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const markCopied = useCallback(() => {
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), resetMs);
  }, [resetMs]);

  return [copied, markCopied];
}
