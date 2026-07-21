// API contract types. Transcript types mirror the backend pydantic models; the
// status / sessions / logs / chat shapes mirror what the `openclaw` CLI emits.

// ToolCall / Turn are the canonical transcript shapes shared across apps; they
// live in @ssot/ui and are re-exported here so local `./types` importers are
// unchanged.
export type { ToolCall, Turn } from "@ssot/ui/transcript-types";
import type { Turn } from "@ssot/ui/transcript-types";

export interface TranscriptDetail {
  agent_id: string;
  session_id: string;
  cwd: string | null;
  model: string | null;
  created_at: string | null;
  updated_at: string | null;
  message_count: number;
  turns: Turn[];
  // How the transcript was resolved: "session" for the session's own JSONL, or
  // "latest_run" when a cron session was served its most recent run's turns.
  source?: string | null;
}

export type SessionKind = "cron" | "group" | "direct" | string;

export interface OpenClawSession {
  key: string;
  sessionId: string;
  updatedAt: number | null;
  ageMs: number | null;
  model: string | null;
  totalTokens: number | null;
  contextTokens: number | null;
  agentId: string;
  kind: SessionKind;
}

export interface SessionsResponse {
  count: number;
  totalCount?: number;
  sessions: OpenClawSession[];
}

export interface StatusResponse {
  runtimeVersion?: string;
  heartbeat?: {
    defaultAgentId?: string;
    agents?: { agentId: string; enabled: boolean; every?: string }[];
  };
  channelSummary?: unknown[];
  sessions?: {
    count?: number;
    defaults?: { model?: string; contextTokens?: number };
  };
  // The CLI may return more; keep it open.
  [key: string]: unknown;
}

export interface LogLine {
  type: string;
  time?: string;
  level?: string;
  subsystem?: string;
  message?: string;
}

export interface ChatResult {
  runId?: string;
  status?: string;
  summary?: string;
  result?: {
    payloads?: { text?: string | null; mediaUrl?: string | null }[];
    meta?: {
      finalAssistantVisibleText?: string;
      sessionId?: string;
      sessionKey?: string;
    };
  };
}

export interface ApiError {
  error: string;
}

// --- models ----------------------------------------------------------------

export interface ModelInfo {
  key: string;
  name: string;
  provider: string;
  available: boolean;
  missing: boolean;
  tags: string[];
  isDefault: boolean;
}

export interface ModelsResponse {
  defaultModel: string | null;
  resolvedDefault: string | null;
  missingProvidersInUse: string[];
  providers: string[];
  models: ModelInfo[];
}

// --- heartbeat / pause -----------------------------------------------------

export interface HeartbeatAgent {
  agentId: string;
  enabled: boolean;
  every?: string;
  everyMs?: number;
}

export interface HeartbeatResponse {
  defaultAgentId: string | null;
  agents: HeartbeatAgent[];
  paused: boolean;
  // Backend's best-known live heartbeat state (authoritative for the UI).
  enabled: boolean;
}

export interface PauseResult {
  paused: boolean;
  heartbeat: { ok: boolean; enabled?: boolean; error?: string };
  cron: {
    ok: boolean;
    failures: { id: string; error: string }[];
    disabled?: string[];
    enabled?: string[];
    error?: string;
  };
}

// --- global instructions ---------------------------------------------------

export interface InstructionFile {
  name: string;
  exists: boolean;
  size: number;
  mtime: string | null;
}

export interface InstructionList {
  workspace: string;
  files: InstructionFile[];
}

export interface InstructionDetail extends InstructionFile {
  content: string;
}

export interface InstructionSaveResult extends InstructionFile {
  backed_up: boolean;
}
