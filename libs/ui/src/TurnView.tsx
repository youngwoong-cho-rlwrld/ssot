import type { ReactNode } from "react";
import { ToolCallView } from "./ToolCallView";
import type { Turn } from "./transcript-types";

interface TurnViewProps {
  turn: Turn;
  // Whether tool-call blocks are rendered. Apps that expose a "show tools"
  // toggle pass it through; defaults to shown.
  showTools?: boolean;
  // Custom renderer for the turn text (e.g. Markdown). Defaults to plain text.
  renderText?: (text: string) => ReactNode;
  // Roles whose uppercase role label is suppressed (e.g. ["user", "assistant"]
  // where the surrounding bubble already conveys the speaker). Defaults to none.
  hideRoleFor?: Turn["role"][];
}

// A single transcript turn: an optional role label, the message text, and any
// tool calls. Shared so every app renders agent sessions identically.
export function TurnView({
  turn,
  showTools = true,
  renderText,
  hideRoleFor,
}: TurnViewProps) {
  const hideRole = hideRoleFor?.includes(turn.role) ?? false;
  return (
    <div className={`turn turn--${turn.role}`}>
      {!hideRole && <div className="turn__role">{turn.role}</div>}
      {turn.text && (
        <div className="turn__text">
          {renderText ? renderText(turn.text) : turn.text}
        </div>
      )}
      {showTools &&
        turn.tool_calls.map((tc, i) => <ToolCallView key={i} call={tc} />)}
    </div>
  );
}
