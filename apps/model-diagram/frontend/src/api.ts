import type {
  ChatEvent,
  ChatHistory,
  CreateDiagramResult,
  CreateRunResult,
  DiagramDetail,
  DiagramListItem,
  HealthResult,
  ModelsResult,
  OutputLine,
  PaperInput,
  PostChatResult,
  RunDetail,
  RunEvent,
  UploadResult,
  ValidateResult,
} from "./types";

// import.meta.env.BASE_URL is the Vite base ("/model-diagram/"), so this
// resolves to "/model-diagram/api" under the gateway and dev proxy alike.
const BASE = `${import.meta.env.BASE_URL}api`;

// Non-2xx responses carry the `{ error, detail? }` envelope (plan §10). Callers
// that surface field-scoped errors (broken_path / broken_paper) read `.error`.
export class ApiError extends Error {
  readonly status: number;
  readonly error: string | null;
  readonly detail: string | null;
  constructor(status: number, error: string | null, detail: string | null) {
    super(detail || error || `request failed: ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.error = error;
    this.detail = detail;
  }
}

async function readError(res: Response): Promise<ApiError> {
  let error: string | null = null;
  let detail: string | null = null;
  try {
    const body = await res.json();
    error = typeof body?.error === "string" ? body.error : null;
    detail = typeof body?.detail === "string" ? body.detail : null;
  } catch {
    // non-JSON body
  }
  return new ApiError(res.status, error, detail);
}

async function requestJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) throw await readError(res);
  return (await res.json()) as T;
}

/** Fire a mutation whose response body we ignore; throws ApiError on non-2xx. */
async function requestVoid(input: string, init?: RequestInit): Promise<void> {
  const res = await fetch(input, init);
  if (!res.ok) throw await readError(res);
}

function jsonBody(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export async function getClusters(signal?: AbortSignal): Promise<string[]> {
  const { clusters } = await requestJson<{ clusters: string[] }>(
    `${BASE}/clusters`,
    { signal },
  );
  return clusters;
}

export async function getHealth(signal?: AbortSignal): Promise<HealthResult> {
  return requestJson<HealthResult>(`${BASE}/health`, { signal });
}

/** The generation-model allowlist and the backend default. */
export async function getModels(signal?: AbortSignal): Promise<ModelsResult> {
  return requestJson<ModelsResult>(`${BASE}/models`, { signal });
}

export interface NewDiagramInput {
  cluster: string;
  path: string;
  paper?: PaperInput | null;
  model?: string;
}

/** Synchronous broken_path + broken_paper prechecks. Always resolves (HTTP 200). */
export async function validate(input: NewDiagramInput): Promise<ValidateResult> {
  return requestJson<ValidateResult>(`${BASE}/validate`, jsonBody(input));
}

/** Upload + immediately validate a PDF. Throws ApiError(broken_paper) on 400. */
export async function uploadPaper(file: File): Promise<UploadResult> {
  const form = new FormData();
  form.append("file", file);
  return requestJson<UploadResult>(`${BASE}/papers/upload`, {
    method: "POST",
    body: form,
  });
}

/** Create a diagram + first run. Throws ApiError(broken_path|broken_paper) on 400. */
export async function createDiagram(
  input: NewDiagramInput,
): Promise<CreateDiagramResult> {
  return requestJson<CreateDiagramResult>(`${BASE}/diagrams`, jsonBody(input));
}

export interface ReprovisionInput {
  cluster?: string;
  path?: string;
  // Omit the key entirely (not null) to inherit the anchor run's paper; null to
  // remove it; a PaperInput to replace it. JSON.stringify drops `undefined` keys,
  // so `paper: undefined` sends the field absent → inherit.
  paper?: PaperInput | null;
  model?: string;
  // The run this re-provision is based on; its paper is inherited when `paper` is
  // omitted.
  anchor_run_id?: number;
}

/** New run under an existing diagram; omitted fields inherit the latest run. */
export async function createRun(
  diagramId: number,
  input: ReprovisionInput,
): Promise<CreateRunResult> {
  return requestJson<CreateRunResult>(
    `${BASE}/diagrams/${diagramId}/runs`,
    jsonBody(input),
  );
}

export async function getDiagrams(
  signal?: AbortSignal,
): Promise<DiagramListItem[]> {
  const { diagrams } = await requestJson<{ diagrams: DiagramListItem[] }>(
    `${BASE}/diagrams`,
    { signal },
  );
  return diagrams;
}

export async function getDiagram(
  id: number,
  signal?: AbortSignal,
): Promise<DiagramDetail> {
  return requestJson<DiagramDetail>(`${BASE}/diagrams/${id}`, { signal });
}

export async function getRun(id: number, signal?: AbortSignal): Promise<RunDetail> {
  return requestJson<RunDetail>(`${BASE}/runs/${id}`, { signal });
}

/** Catch-up fetch of the agent-output log (the SSE stream also replays these). */
export async function getRunOutput(
  id: number,
  afterSeq = 0,
  signal?: AbortSignal,
): Promise<{ lines: OutputLine[]; last_seq: number }> {
  return requestJson<{ lines: OutputLine[]; last_seq: number }>(
    `${BASE}/runs/${id}/output?after_seq=${afterSeq}`,
    { signal },
  );
}

export function deleteDiagram(id: number): Promise<void> {
  return requestVoid(`${BASE}/diagrams/${id}`, { method: "DELETE" });
}

/** Save a diagram's memo (free-text note). Throws ApiError(404) if not found. */
export function updateDiagramMemo(id: number, memo: string): Promise<void> {
  return requestVoid(`${BASE}/diagrams/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ memo }),
  });
}

/** Cancel a running run. Throws ApiError(409) if the run is already terminal. */
export function cancelRun(id: number): Promise<void> {
  return requestVoid(`${BASE}/runs/${id}/cancel`, { method: "POST" });
}

/** Self-contained rendered diagram page, embedded in an iframe. */
export function runPageUrl(runId: number): string {
  return `${BASE}/runs/${runId}/page`;
}

export interface RunEventHandlers {
  onStage?: (stage: string, detail: string, ts: string) => void;
  onWarning?: (kind: string, detail: string) => void;
  onLog?: (seq: number, line: string, ts: string) => void;
  onDone?: (runId: number) => void;
  onError?: (kind: string, detail: string) => void;
}

/**
 * Subscribe to a run's SSE stream. EventSource replays persisted stages then
 * tails live events until a terminal frame; it auto-reconnects on transient
 * drops, so we close it ourselves on `done`/`error`. Returns a disposer.
 */
export function openRunEvents(
  runId: number,
  handlers: RunEventHandlers,
): () => void {
  // EventSource stops retrying for good when a reconnect hits a hard HTTP
  // failure (e.g. 502 while the backend restarts), so recreate it ourselves.
  // The backend replays persisted stage events on every connect, and the
  // handlers are idempotent, so a fresh connection restores full state.
  let es: EventSource;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = () => {
    es = new EventSource(`${BASE}/runs/${runId}/events`);
    es.onerror = () => {
      if (closed || es.readyState !== EventSource.CLOSED) return;
      retry = setTimeout(connect, 3000);
    };
    attach(es);
  };
  const attach = (es: EventSource) => {
  es.onmessage = (ev) => {
    let event: RunEvent | null = null;
    try {
      event = JSON.parse(ev.data) as RunEvent;
    } catch {
      return;
    }
    if (!event) return;
    switch (event.type) {
      case "stage":
        handlers.onStage?.(event.stage, event.detail, event.ts);
        break;
      case "warning":
        handlers.onWarning?.(event.kind, event.detail);
        break;
      case "log":
        handlers.onLog?.(event.seq, event.line, event.ts);
        break;
      case "done":
        closed = true;
        es.close();
        handlers.onDone?.(event.run_id);
        break;
      case "error":
        closed = true;
        es.close();
        handlers.onError?.(event.kind, event.detail);
        break;
    }
  };
  };
  connect();
  return () => {
    closed = true;
    if (retry !== null) clearTimeout(retry);
    es.close();
  };
}

// ── chat ────────────────────────────────────────────────────────────────

/** Full chat history (thread + messages) for a single run. */
export async function getChat(
  runId: number,
  signal?: AbortSignal,
): Promise<ChatHistory> {
  return requestJson<ChatHistory>(`${BASE}/runs/${runId}/chat`, { signal });
}

/** Ask a follow-up question on a completed run's thread. Throws on 404/409. */
export async function postChat(
  runId: number,
  message: string,
  model?: string,
): Promise<PostChatResult> {
  return requestJson<PostChatResult>(
    `${BASE}/runs/${runId}/chat`,
    jsonBody({ message, model }),
  );
}

/** Cancel a pending chat turn. Throws ApiError(409) if it already finished. */
export function cancelChat(messageId: number): Promise<void> {
  return requestVoid(`${BASE}/chat/${messageId}/cancel`, { method: "POST" });
}

export interface ChatEventHandlers {
  onLog?: (seq: number, line: string) => void;
  onMessage?: (msg: Extract<ChatEvent, { type: "message" }>) => void;
  onError?: (detail: string) => void;
}

/**
 * Subscribe to one assistant chat message's SSE stream. Mirrors openRunEvents:
 * replays the turn's log, streams new lines + status, and closes on the terminal
 * `message` frame (status done/error). Returns a disposer.
 */
export function openChatEvents(
  messageId: number,
  handlers: ChatEventHandlers,
): () => void {
  let es: EventSource;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = () => {
    es = new EventSource(`${BASE}/chat/${messageId}/events`);
    es.onerror = () => {
      if (closed || es.readyState !== EventSource.CLOSED) return;
      retry = setTimeout(connect, 3000);
    };
    es.onmessage = (ev) => {
      let event: ChatEvent | null = null;
      try {
        event = JSON.parse(ev.data) as ChatEvent;
      } catch {
        return;
      }
      if (!event) return;
      if (event.type === "log") {
        handlers.onLog?.(event.seq, event.line);
      } else if (event.type === "message") {
        handlers.onMessage?.(event);
        if (event.status !== "pending") {
          closed = true;
          es.close();
        }
      } else if (event.type === "error") {
        closed = true;
        es.close();
        handlers.onError?.(event.detail);
      }
    };
  };
  connect();
  return () => {
    closed = true;
    if (retry !== null) clearTimeout(retry);
    es.close();
  };
}
