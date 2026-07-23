export function formatPct(value: number) {
  return `${(value * 100).toFixed(2)}%`;
}

/** Last non-empty path segment, falling back to the original string. */
export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Human-readable byte size, e.g. "512 B", "1.5 MB". Returns "-" for null. */
export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
