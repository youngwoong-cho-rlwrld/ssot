import { Eye, EyeOff } from "lucide-react";

type ToolVisibilityToggleProps = {
  visible: boolean;
  onToggle: () => void;
  context: "chat" | "transcript";
};

export function ToolVisibilityToggle({
  visible,
  onToggle,
  context,
}: ToolVisibilityToggleProps) {
  const content =
    context === "chat"
      ? "tool calls made by the agent in this chat"
      : "tool calls and system messages in this transcript";
  const label = `${visible ? "Hide" : "Show"} ${content}`;

  return (
    <button
      type="button"
      className={`ssot-btn tool-toggle${visible ? " tool-toggle--on" : ""}`}
      onClick={onToggle}
      aria-label={label}
      aria-pressed={visible}
      data-tooltip={label}
    >
      {visible ? <Eye size={13} /> : <EyeOff size={13} />}
    </button>
  );
}
