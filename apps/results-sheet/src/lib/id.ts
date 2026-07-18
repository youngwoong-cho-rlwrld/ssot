// Random client-side id with a prefixed fallback when crypto.randomUUID is
// unavailable. The prefix is never parsed — it only aids debugging.
export function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${prefix}-${Math.random().toString(16).slice(2)}`;
}
