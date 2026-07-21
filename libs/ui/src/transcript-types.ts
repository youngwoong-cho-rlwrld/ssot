// Canonical transcript shapes shared across apps that render agent sessions.
// These mirror the backend pydantic models and MUST match them exactly. Only
// the genuinely identical transcript types live here; app-specific types
// (session index, CLI status/logs/chat, etc.) stay in each app's own types.ts.

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
