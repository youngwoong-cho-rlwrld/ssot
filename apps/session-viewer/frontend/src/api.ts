import type {
  BoardNode,
  CleanupCategory,
  CleanupPreview,
  CleanupResult,
  Session,
  SessionDetail,
} from "./types";

// import.meta.env.BASE_URL is the Vite base ("/sessions/"), so this resolves to
// "/sessions/api" under the gateway and dev proxy alike.
const BASE = `${import.meta.env.BASE_URL}api`;

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      // ignore body read errors
    }
    throw new Error(
      `${init?.method ?? "GET"} ${input} failed: ${res.status} ${res.statusText}${
        detail ? ` - ${detail}` : ""
      }`,
    );
  }
  return (await res.json()) as T;
}

export interface SessionsParams {
  agent?: "claude" | "codex";
  project?: string;
  q?: string;
  since?: string;
  signal?: AbortSignal;
}

export async function getSessions(params: SessionsParams = {}): Promise<Session[]> {
  const search = new URLSearchParams();
  if (params.agent) search.set("agent", params.agent);
  if (params.project) search.set("project", params.project);
  if (params.q) search.set("q", params.q);
  if (params.since) search.set("since", params.since);
  const qs = search.toString();
  return request<Session[]>(`${BASE}/sessions${qs ? `?${qs}` : ""}`, {
    signal: params.signal,
  });
}

export async function getDetail(
  agent: string,
  id: string,
  signal?: AbortSignal,
): Promise<SessionDetail> {
  return request<SessionDetail>(
    `${BASE}/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(id)}`,
    { signal },
  );
}

export async function getBoard(signal?: AbortSignal): Promise<BoardNode[]> {
  return request<BoardNode[]>(`${BASE}/board`, { signal });
}

export async function putBoardNode(
  uid: string,
  partial: Partial<Omit<BoardNode, "uid">>,
): Promise<BoardNode> {
  return request<BoardNode>(`${BASE}/board/${encodeURIComponent(uid)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  });
}

export async function getCleanupPreview(
  categories: CleanupCategory[],
  signal?: AbortSignal,
): Promise<CleanupPreview> {
  const search = new URLSearchParams();
  for (const category of categories) search.append("categories", category);
  const qs = search.toString();
  return request<CleanupPreview>(`${BASE}/cleanup${qs ? `?${qs}` : ""}`, {
    signal,
  });
}

export async function cleanupSessions(
  categories: CleanupCategory[],
  affectedUids: string[],
): Promise<CleanupResult> {
  return request<CleanupResult>(`${BASE}/cleanup`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ categories, affected_uids: affectedUids }),
  });
}

export interface DeleteResult {
  status: string;
  uid: string;
  trashed_to: string;
}

/** Delete a session entirely: the backend moves its file to the Trash. */
export async function deleteSession(
  agent: string,
  id: string,
): Promise<DeleteResult> {
  return request<DeleteResult>(
    `${BASE}/sessions/${encodeURIComponent(agent)}/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
}
