// Domain types mirroring the backend HTTP contract (plan §10). Field names and
// shapes here are the wire contract — keep them verbatim.

// cluster is a configured cluster name plus "local"; the real option list comes
// from GET /api/clusters at runtime (these are only the static fallback).
export type Cluster = string;

export const FALLBACK_CLUSTERS: string[] = ["local", "kakao", "skt", "mlxp"];

export type Status = "running" | "done" | "error";

export type PaperStatus = "none" | "attached" | "mismatch";

export type ErrorKind =
  | "broken_path"
  | "broken_paper"
  | "not_a_model_root"
  | "agent_failure"
  | "credentials_not_configured"
  | "cancelled";

// report_stage transitions (plan §7). The two paper stages only occur when a
// paper is attached; the checklist hides them otherwise.
export type Stage =
  | "inspecting_root"
  | "pinning_commit"
  | "mapping_pipeline"
  | "locating_sources"
  | "verifying_lines"
  | "reading_paper"
  | "cross_checking_paper"
  | "laying_out"
  | "finalizing";

// Attached to validate / create requests. Discriminated by `kind`; paper_ref
// comes from POST /api/papers/upload.
export type PaperInput =
  | { kind: "url"; url: string }
  | { kind: "pdf"; paper_ref: string };

export interface RunSummary {
  run_id: number;
  status: Status;
  cluster: string;
  path: string;
  commit_hash: string | null;
  title: string | null;
  has_paper: boolean;
  paper_status: PaperStatus;
  error_kind: string | null;
  created_at: string;
}

export interface StageEvent {
  stage: string;
  detail: string;
  ts: string;
}

export interface RunDetail extends RunSummary {
  diagram_id: number;
  model: string | null;
  error_detail: string | null;
  paper_warning: string | null;
  updated_at: string;
  stages: StageEvent[];
}

export interface DiagramListItem {
  id: number;
  path: string;
  memo: string;
  latest_run: RunSummary;
}

export interface DiagramDetail {
  id: number;
  path: string;
  memo: string;
  runs: RunSummary[];
}

// One condensed line of live agent activity (GET /api/runs/:id/output rows and
// the SSE `log` frame carry the same shape).
export interface OutputLine {
  seq: number;
  line: string;
  ts: string;
}

// GET /api/runs/:id/events — SSE frames, discriminated by `type`.
export type RunEvent =
  | { type: "stage"; stage: string; detail: string; ts: string }
  | { type: "warning"; kind: "paper_mismatch"; detail: string }
  | { type: "log"; seq: number; line: string; ts: string }
  | { type: "done"; run_id: number }
  | { type: "error"; kind: ErrorKind; detail: string };

// ── chat (follow-up conversation about a diagram) ─────────────────────────

export type ChatRole = "user" | "assistant";
export type ChatStatus = "pending" | "done" | "error";

export interface ChatMessage {
  id: number;
  role: ChatRole;
  content: string;
  status: ChatStatus;
  error_detail: string | null;
  revised_run_id: number | null;
  anchor_run_id: number | null;
  seq: number;
  created_at: string;
}

export interface ChatHistory {
  thread_id: number;
  messages: ChatMessage[];
}

export interface PostChatResult {
  thread_id: number;
  assistant_message_id: number;
}

// GET /api/chat/:message_id/events — SSE frames, discriminated by `type`.
export type ChatEvent =
  | { type: "log"; seq: number; line: string; ts: string }
  | {
      type: "message";
      id: number;
      role: ChatRole;
      content: string;
      status: ChatStatus;
      error_detail: string | null;
      revised_run_id: number | null;
      seq: number;
      ts: string;
    }
  | { type: "error"; detail: string };

// POST /api/validate — always HTTP 200; discriminated by `ok`.
export type ValidateResult =
  | { ok: true }
  | {
      ok: false;
      path_error: "broken_path" | null;
      paper_error: "broken_paper" | null;
      detail: string;
    };

// POST /api/papers/upload success body (failure is HTTP 400 → thrown).
export interface UploadResult {
  paper_ref: string;
  filename: string;
  page_count: number;
  sha256: string;
}

export interface CreateDiagramResult {
  diagram_id: number;
  run_id: number;
}

export interface CreateRunResult {
  run_id: number;
}

// Which generation runtime the backend will use: the Anthropic SDK (API key),
// the logged-in Claude Code CLI, or none configured. `anthropic_configured` is
// retained for backward compatibility.
export type Runtime = "sdk" | "claude-cli" | "none";

// Per-family runtime availability (GET /api/health `runtimes`).
export type ClaudeRuntime = "sdk" | "cli" | null;
export type CodexRuntime = "cli" | null;

export interface HealthResult {
  status: string;
  anthropic_configured: boolean;
  runtime: Runtime;
  runtimes?: { claude: ClaudeRuntime; codex: CodexRuntime };
}

// GET /api/models — the generation-model allowlist and the backend default.
export type ModelFamily = "claude" | "codex";

export interface ModelOption {
  id: string;
  label: string;
  family?: ModelFamily;
}

export interface ModelsResult {
  models: ModelOption[];
  default: string;
}
