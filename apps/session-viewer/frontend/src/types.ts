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

// ToolCall / Turn are the canonical transcript shapes shared across apps; they
// live in @ssot/ui and are re-exported here so local `./types` importers are
// unchanged.
export type { ToolCall, Turn } from "@ssot/ui/transcript-types";
import type { Turn } from "@ssot/ui/transcript-types";

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
