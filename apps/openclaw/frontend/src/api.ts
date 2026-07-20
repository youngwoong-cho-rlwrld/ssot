import type {
  ChatResult,
  SessionsResponse,
  StatusResponse,
  LogLine,
  TranscriptDetail,
  InstructionList,
  InstructionDetail,
  InstructionSaveResult,
  ModelsResponse,
  HeartbeatResponse,
  PauseResult,
} from "./types";

// import.meta.env.BASE_URL is the Vite base ("/openclaw/"), so this resolves to
// "/openclaw/api" under the gateway and the dev proxy alike.
export const API_BASE = `${import.meta.env.BASE_URL}api`;

/**
 * Error thrown for a non-2xx response. ``kind`` mirrors the backend's error
 * discriminator (e.g. "cli_missing", "gateway_down") when present, so callers
 * can branch on it; ``detail`` is the human-readable message.
 */
export class ApiError extends Error {
  status: number;
  kind?: string;
  detail?: string;
  constructor(status: number, kind: string | undefined, detail: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.kind = kind;
    this.detail = detail;
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    let kind: string | undefined;
    let detail = "";
    try {
      const body = await res.json();
      if (typeof body?.error === "string") kind = body.error;
      detail =
        (typeof body?.detail === "string" && body.detail) ||
        (typeof body?.error === "string" && body.error) ||
        JSON.stringify(body);
    } catch {
      try {
        detail = await res.text();
      } catch {
        // ignore body read errors
      }
    }
    throw new ApiError(
      res.status,
      kind,
      detail,
      `${init?.method ?? "GET"} ${input} failed: ${res.status}${
        detail ? ` - ${detail}` : ""
      }`,
    );
  }
  return (await res.json()) as T;
}

export function getStatus(signal?: AbortSignal): Promise<StatusResponse> {
  return request<StatusResponse>(`${API_BASE}/status`, { signal });
}

export function getSessions(
  limit = 100,
  signal?: AbortSignal,
): Promise<SessionsResponse> {
  return request<SessionsResponse>(`${API_BASE}/sessions?limit=${limit}`, {
    signal,
  });
}

export function getTranscript(
  agentId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<TranscriptDetail> {
  return request<TranscriptDetail>(
    `${API_BASE}/sessions/${encodeURIComponent(agentId)}/${encodeURIComponent(
      sessionId,
    )}`,
    { signal },
  );
}

/**
 * Fetch a transcript by session key rather than sessionId. Used for sessions
 * whose transcript isn't reachable by sessionId alone — notably cron sessions,
 * whose store entry has no sessionId and whose runs write to a separate store;
 * the backend resolves the latest run.
 */
export function getTranscriptByKey(
  agentId: string,
  sessionKey: string,
  signal?: AbortSignal,
): Promise<TranscriptDetail> {
  const q = new URLSearchParams({ agent_id: agentId, key: sessionKey });
  return request<TranscriptDetail>(`${API_BASE}/sessions/by-key?${q}`, {
    signal,
  });
}

export function getLogs(limit = 200, signal?: AbortSignal): Promise<LogLine[]> {
  return request<LogLine[]>(`${API_BASE}/logs?limit=${limit}`, { signal });
}

export function deleteSession(
  agentId: string,
  sessionId: string,
  force = false,
): Promise<{ deleted: boolean; session_key: string; files_removed: string[] }> {
  const q = force ? "?force=true" : "";
  return request(
    `${API_BASE}/sessions/${encodeURIComponent(agentId)}/${encodeURIComponent(
      sessionId,
    )}${q}`,
    { method: "DELETE" },
  );
}

export const logsStreamUrl = `${API_BASE}/logs/stream`;

export function postChat(
  message: string,
  sessionKey?: string,
  model?: string,
  signal?: AbortSignal,
): Promise<ChatResult> {
  return request<ChatResult>(`${API_BASE}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, session_key: sessionKey, model }),
    signal,
  });
}

export function getModels(signal?: AbortSignal): Promise<ModelsResponse> {
  return request<ModelsResponse>(`${API_BASE}/models`, { signal });
}

export function setDefaultModel(model: string): Promise<{ ok: boolean; defaultModel: string }> {
  return request(`${API_BASE}/models/default`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
}

export function setModelAuth(
  provider: string,
  apiKey: string,
): Promise<{ ok: boolean; provider: string }> {
  return request(`${API_BASE}/models/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, api_key: apiKey }),
  });
}

export function getHeartbeat(signal?: AbortSignal): Promise<HeartbeatResponse> {
  return request<HeartbeatResponse>(`${API_BASE}/heartbeat`, { signal });
}

export function setHeartbeat(body: {
  every?: string;
  enabled?: boolean;
}): Promise<{ ok: boolean; every?: string; enabled?: boolean }> {
  return request(`${API_BASE}/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function setPause(paused: boolean): Promise<PauseResult> {
  return request<PauseResult>(`${API_BASE}/pause`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused }),
  });
}

export function getInstructions(signal?: AbortSignal): Promise<InstructionList> {
  return request<InstructionList>(`${API_BASE}/instructions`, { signal });
}

export function getInstruction(
  name: string,
  signal?: AbortSignal,
): Promise<InstructionDetail> {
  return request<InstructionDetail>(
    `${API_BASE}/instructions/${encodeURIComponent(name)}`,
    { signal },
  );
}

export function putInstruction(
  name: string,
  content: string,
): Promise<InstructionSaveResult> {
  return request<InstructionSaveResult>(
    `${API_BASE}/instructions/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
}

/** Pull the assistant's visible reply out of a chat result. */
export function assistantReply(res: ChatResult): string {
  const payloadText = (res.result?.payloads ?? [])
    .map((p) => p?.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
  if (payloadText) return payloadText;
  return res.result?.meta?.finalAssistantVisibleText?.trim() ?? "";
}
