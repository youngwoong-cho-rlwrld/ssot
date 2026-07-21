import { memo } from "react";
import type { NodeProps, Node } from "@xyflow/react";
import { Star, MessageSquare } from "lucide-react";
import type { Session } from "../types";
import { defaultColorFor, relativeTime, rotationFor } from "./util";

export interface PostItData extends Record<string, unknown> {
  session: Session;
  color: string | null;
  starred: boolean;
  highlighted: boolean;
  lod: boolean; // true = zoomed out: render a cheap skeleton instead of content
  onToggleStar: (uid: string) => void;
}

export type PostItNodeType = Node<PostItData, "postit">;

function PostItNodeImpl({ data, selected }: NodeProps<PostItNodeType>) {
  const { session, color, starred, highlighted, lod, onToggleStar } = data;
  const bg = color ?? defaultColorFor(session.agent);
  const rotation = rotationFor(session.uid);
  const agentClass = session.agent;

  // Zoomed out: text is unreadable anyway, so skip all text + SVG icons (the
  // expensive part to lay out and paint) and render a lightweight placeholder.
  if (lod) {
    return (
      <div
        className={`postit postit--skeleton${selected ? " postit--selected" : ""}${highlighted ? " postit--cleanup-highlight" : ""}`}
        style={{ background: bg, transform: `rotate(${rotation}deg)` }}
      >
        <span
          className={`sk sk--chip sk--${agentClass}`}
        />
        <span className="sk sk--line" />
        <span className="sk sk--line" />
        <span className="sk sk--line sk--short" />
      </div>
    );
  }

  return (
    <div
      className={`postit${selected ? " postit--selected" : ""}${highlighted ? " postit--cleanup-highlight" : ""}`}
      style={{ background: bg, transform: `rotate(${rotation}deg)` }}
    >
      <div className="postit__top">
        <span className={`chip chip--${agentClass}`}>
          {session.agent}
        </span>
        {session.active && (
          <span className="pulse" title="active" aria-label="active session">
            <span className="pulse__dot" />
            <span className="pulse__ring" />
          </span>
        )}
        <button
          type="button"
          className={`star-btn nodrag${starred ? " star-btn--on" : ""}`}
          title={starred ? "Unstar" : "Star"}
          aria-pressed={starred}
          // The nodrag class prevents react-flow from treating this as a drag start.
          onClick={(e) => {
            e.stopPropagation();
            onToggleStar(session.uid);
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Star size={15} fill={starred ? "currentColor" : "none"} />
        </button>
      </div>

      <div className="postit__title" title={session.title}>
        {session.title || "(untitled)"}
      </div>

      <div className="postit__meta">
        <span className="postit__project" title={session.cwd}>
          {session.project}
        </span>
        <span className="postit__metaright">
          <span className="postit__msgs" title={`${session.message_count} messages`}>
            <MessageSquare size={12} />
            {session.message_count}
          </span>
          <span className="postit__time" title={session.updated_at}>
            {relativeTime(session.updated_at)}
          </span>
        </span>
      </div>
    </div>
  );
}

// nodrag class on interactive children is added per-element above; memoize the
// whole node so unrelated board updates don't re-render every card.
export const PostItNode = memo(PostItNodeImpl);
