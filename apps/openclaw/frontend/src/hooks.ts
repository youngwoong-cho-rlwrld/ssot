import { useCallback, useEffect, useState } from "react";

/** A boolean state persisted to localStorage under `key`. */
export function usePersistedBool(
  key: string,
  initial: boolean,
): [boolean, () => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : raw === "true";
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      // localStorage unavailable (private mode etc.); toggle still works in-memory.
    }
  }, [key, value]);

  const toggle = useCallback(() => setValue((v) => !v), []);
  return [value, toggle];
}
