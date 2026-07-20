// Shared config + fetch helpers for talking to the train-eval-web backend.
// Used by both API route handlers (server-only).

export const API_BASE =
  process.env.RESULTS_API_BASE ??
  "http://127.0.0.1:8000";

export const CLUSTERS_TIMEOUT_MS = 10_000;
export const RESULT_CLUSTER_TIMEOUT_MS = positiveIntegerEnv(
  "RESULTS_CLUSTER_TIMEOUT_MS",
  195_000,
);

// Fetch with an abort-based timeout. Throws a "timed out after Nms" error on
// timeout so callers can surface a clear message.
export async function fetchUpstream(
  url: URL,
  timeoutMs: number,
  headers: HeadersInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      cache: "no-store",
      headers: { Accept: "application/json", ...Object.fromEntries(new Headers(headers)) },
      signal: controller.signal,
    });
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new Error(`${url.toString()} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// fetchUpstream plus response.ok check and JSON parsing.
export async function fetchUpstreamJson<T>(
  url: URL,
  timeoutMs: number,
  headers: HeadersInit = {},
): Promise<T> {
  const response = await fetchUpstream(url, timeoutMs, headers);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${url.toString()} returned ${response.status}: ${body.slice(0, 240)}`);
  }
  return JSON.parse(body) as T;
}

function positiveIntegerEnv(name: string, fallback: number) {
  const configured = process.env[name];
  if (configured === undefined) return fallback;
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
