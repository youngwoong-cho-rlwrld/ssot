// Base path the app is mounted at behind the SSOT gateway (e.g. "/results").
// next.config.ts sets `basePath`, which prefixes pages and the app's own API
// routes. Client-side fetch() to a root-relative path is NOT prefixed
// automatically, so every internal fetch/link must go through apiPath().
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Prefix an app-internal, root-relative path (e.g. "/api/results") with the
// configured base path. Pass only internal paths here; external absolute URLs
// (the agent server, upstream API) must not be prefixed.
export function apiPath(path: string): string {
  return `${BASE_PATH}${path}`;
}
