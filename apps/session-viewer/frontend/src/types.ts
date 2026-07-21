// Shared API contract types. These MUST match the backend pydantic models exactly.

export type Agent = "claude" | "codex" | "openclaw";

export interface Session {
  uid: string; // `${agent}:${id}`
  agent: Agent;
  id: string; // uuid (filename stem)
  path: string; // absolute path to the .jsonl
  project: string; // basename of cwd, or "unknown"
  cwd: string;
  title: string;
  last_prompt: string | null;
  model: string | null;
  git_branch: string | null;
  cli_version: string | null;
  created_at: string | null; // ISO8601
  updated_at: string; // ISO8601 (falls back to file mtime)
  message_count: number;
  active: boolean; // file mtime within ACTIVE_WINDOW seconds (default 300)
}

export interface ToolCall {
  name: string;
  input_preview: string; // truncated (<= 2000 chars)
  output_preview: string | null;
}

export interface Turn {
  role: "user" | "assistant" | "system";
  text: string;
  tool_calls: ToolCall[];
  ts: string | null;
}

export interface SessionDetail extends Session {
  turns: Turn[];
}

export interface BoardNode {
  uid: string;
  x: number;
  y: number;
  color: string | null;
  starred: boolean;
  note: string;
}

export type CleanupCategory = "system" | "old" | "short";

export interface CleanupPreview {
  counts: Record<CleanupCategory, number>;
  affected: number;
  affected_uids: string[];
}

export interface CleanupResult {
  status: "deleted" | "partial";
  affected: number;
  deleted: number;
  failed: number;
}
