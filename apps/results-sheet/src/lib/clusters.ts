export const MAX_CLUSTER_LENGTH = 64;
export const MAX_CLUSTER_COUNT = 64;

const VALID_CLUSTER = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isValidClusterName(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= MAX_CLUSTER_LENGTH
    && VALID_CLUSTER.test(value);
}

export function normalizeClusterNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const name = typeof item === "string" ? item.trim() : "";
    if (!isValidClusterName(name) || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= MAX_CLUSTER_COUNT) break;
  }
  return names;
}
