import type { ToolCall } from "./transcript-types";

function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  const line = nl === -1 ? s : s.slice(0, nl);
  return line.length > 120 ? `${line.slice(0, 120)}...` : line;
}

// A single tool call rendered as a collapsible plain-text block (never markdown).
// Shared across apps so chat threads and transcripts look identical.
export function ToolCallView({ call }: { call: ToolCall }) {
  return (
    <details className="tool">
      <summary className="tool__summary">
        <span className="tool__name">{call.name}</span>
        <span className="tool__preview">{firstLine(call.input_preview)}</span>
      </summary>
      <div className="tool__body">
        <div className="tool__label">input</div>
        <pre className="tool__pre">{call.input_preview}</pre>
        {call.output_preview != null && (
          <>
            <div className="tool__label">output</div>
            <pre className="tool__pre">{call.output_preview}</pre>
          </>
        )}
      </div>
    </details>
  );
}
