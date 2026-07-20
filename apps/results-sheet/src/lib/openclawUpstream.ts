const OPENCLAW_API_BASE =
  process.env.OPENCLAW_API_BASE ??
  "http://127.0.0.1:8790";

export const OPENCLAW_MODELS_TIMEOUT_MS = 20_000;
export const OPENCLAW_CHAT_TIMEOUT_MS = positiveIntegerEnv(
  "OPENCLAW_CHAT_TIMEOUT_MS",
  140_000,
);

export function openClawApiUrl(path: string) {
  return new URL(path, OPENCLAW_API_BASE);
}

export async function fetchOpenClawJson<T>(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const sourceSignal = init.signal;
  let timedOut = false;
  const relayAbort = () => controller.abort(sourceSignal?.reason);
  if (sourceSignal?.aborted) relayAbort();
  else sourceSignal?.addEventListener("abort", relayAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        ...init.headers,
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      throw new Error(openClawError(payload) ?? `${response.status} ${response.statusText}`);
    }
    return payload as T;
  } catch (error) {
    if (timedOut) {
      throw new Error(`OpenClaw timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    sourceSignal?.removeEventListener("abort", relayAbort);
  }
}

function openClawError(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.detail === "string" && record.detail) return record.detail;
  if (typeof record.error === "string" && record.error) return record.error;
  return null;
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
