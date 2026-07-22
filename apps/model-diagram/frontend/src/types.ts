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
  | "credentials_not_configured";

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
  latest_run: RunSummary;
}

export interface DiagramDetail {
  id: number;
  path: string;
  runs: RunSummary[];
}

// GET /api/runs/:id/events — SSE frames, discriminated by `type`.
export type RunEvent =
  | { type: "stage"; stage: string; detail: string; ts: string }
  | { type: "warning"; kind: "paper_mismatch"; detail: string }
  | { type: "done"; run_id: number }
  | { type: "error"; kind: ErrorKind; detail: string };

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

export interface HealthResult {
  status: string;
  anthropic_configured: boolean;
  runtime: Runtime;
}

// GET /api/models — the generation-model allowlist and the backend default.
export interface ModelOption {
  id: string;
  label: string;
}

export interface ModelsResult {
  models: ModelOption[];
  default: string;
}
