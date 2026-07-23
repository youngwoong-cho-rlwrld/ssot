/** Narrow an unknown thrown value to a message string. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Extract a server-provided error string from a parsed JSON payload, if any. */
export function payloadErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string") return record.error;
  if (!Array.isArray(record.errors)) return null;
  const first = record.errors[0];
  return first && typeof first === "object" && typeof (first as Record<string, unknown>).error === "string"
    ? String((first as Record<string, unknown>).error)
    : null;
}

/** Parse a Response body as a JSON object, or {} when it is not an object. */
export async function readJsonRecord(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json() as unknown;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

/** GET a URL and parse JSON, throwing a server-provided message on failure. */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    throw new Error(payloadErrorMessage(payload) ?? `${response.status} ${response.statusText}`);
  }
  return payload as T;
}
