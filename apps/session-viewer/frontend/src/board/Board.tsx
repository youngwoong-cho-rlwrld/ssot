import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useStore,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import { PostItNode, type PostItData, type PostItNodeType } from "./PostItNode";
import { computeAutoLayout } from "./autoLayout";
import { defaultColorFor } from "./util";
import type { BoardNode, Session } from "../types";

const nodeTypes: NodeTypes = { postit: PostItNode };

// Below this zoom, cards render as skeletons (text is unreadable at that scale).
const LOD_ZOOM = 0.6;

interface BoardProps {
  sessions: Session[]; // already filtered
  board: Map<string, BoardNode>;
  selectedUid: string | null;
  onSelect: (uid: string) => void;
  onMoveNode: (uid: string, x: number, y: number) => void;
  onToggleStar: (uid: string) => void;
}

function BoardInner({
  sessions,
  board,
  selectedUid,
  onSelect,
  onMoveNode,
  onToggleStar,
}: BoardProps) {
  // Subscribe to a boolean derived from zoom: this component only re-renders
  // when we cross the LOD threshold, not on every zoom tick.
  const lod = useStore((s) => s.transform[2] < LOD_ZOOM);

  // Auto-layout only depends on the session set, so memoize it separately;
  // selection changes must not trigger a full re-layout.
  const auto = useMemo(() => computeAutoLayout(sessions), [sessions]);

  // Reuse node objects across renders: when board/session data for a card is
  // unchanged, we hand react-flow the exact same node reference so it (and
  // PostItNode's memo) skip it entirely. Only the card that actually changed
  // gets a new object — keeping drag/board updates O(1) instead of O(all).
  const cacheRef = useRef<Map<string, { node: PostItNodeType; sig: string }>>(
    new Map(),
  );

  // Build node data independently of selection so a click doesn't rebuild every
  // card's `data` object (which would break PostItNode's memo for all 443 nodes).
  const baseNodes = useMemo<PostItNodeType[]>(() => {
    const cache = cacheRef.current;
    const seen = new Set<string>();
    const out = sessions.map((session) => {
      const saved = board.get(session.uid);
      const color = saved?.color ?? defaultColorFor(session.agent);
      const starred = saved?.starred ?? false;
      const pos = saved
        ? { x: saved.x, y: saved.y }
        : auto[session.uid] ?? { x: 0, y: 0 };
      const sig = `${color}|${starred}|${pos.x}|${pos.y}|${lod ? 1 : 0}`;
      seen.add(session.uid);

      const cached = cache.get(session.uid);
      // session refs are stable across polls (useSessions reconcile) and
      // onToggleStar is a stable useCallback, so sig + session identity fully
      // captures whether this node needs rebuilding.
      if (cached && cached.sig === sig && cached.node.data.session === session) {
        return cached.node;
      }
      const data: PostItData = { session, color, starred, lod, onToggleStar };
      const node: PostItNodeType = {
        id: session.uid,
        type: "postit",
        position: pos,
        data,
        selected: false,
        // Match the rendered card footprint so MiniMap + fitView are accurate.
        width: 220,
        height: 150,
      };
      cache.set(session.uid, { node, sig });
      return node;
    });
    for (const uid of cache.keys()) if (!seen.has(uid)) cache.delete(uid);
    return out;
  }, [sessions, auto, board, onToggleStar, lod]);

  // Apply selection as a shallow overlay: reuse the same node reference for every
  // card except the (un)selected one, so react-flow only re-renders what changed.
  const derivedNodes = useMemo<PostItNodeType[]>(
    () =>
      baseNodes.map((n) =>
        (n.id === selectedUid) === Boolean(n.selected)
          ? n
          : { ...n, selected: n.id === selectedUid },
      ),
    [baseNodes, selectedUid],
  );

  // React-flow owns the live node array so drag moves are applied to what's
  // rendered (the card follows the cursor). We push our derived nodes into it,
  // but NOT mid-drag — otherwise a background poll would resync and snap the
  // dragged card back to its persisted position.
  const [nodes, setNodes, onNodesChange] =
    useNodesState<PostItNodeType>(derivedNodes);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (draggingRef.current) return;
    setNodes(derivedNodes);
  }, [derivedNodes, setNodes]);

  // Apply every change to the live state (so drags render), and persist only the
  // final drag-stop position back to the board.
  const handleNodesChange = useCallback(
    (changes: NodeChange<PostItNodeType>[]) => {
      for (const change of changes) {
        if (change.type === "position") {
          if (change.dragging) {
            draggingRef.current = true;
          } else if (change.dragging === false) {
            draggingRef.current = false;
            if (change.position) {
              onMoveNode(change.id, change.position.x, change.position.y);
            }
          }
        }
      }
      onNodesChange(changes);
    },
    [onNodesChange, onMoveNode],
  );

  const onNodeClick = useCallback<NodeMouseHandler<PostItNodeType>>(
    (_event, node) => {
      onSelect(node.id);
    },
    [onSelect],
  );

  const minimapColor = useCallback((node: Node) => {
    const data = node.data as PostItData;
    return data.color ?? defaultColorFor(data.session.agent);
  }, []);

  return (
    <ReactFlow
      nodes={nodes}
      edges={[]}
      nodeTypes={nodeTypes}
      onNodesChange={handleNodesChange}
      onNodeClick={onNodeClick}
      nodesDraggable
      nodesConnectable={false}
      elementsSelectable
      elevateNodesOnSelect={false}
      onlyRenderVisibleElements
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.15}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={28}
        size={1.4}
        color="var(--board-dot)"
      />
      <MiniMap
        pannable
        zoomable
        nodeColor={minimapColor}
        nodeStrokeWidth={2}
        maskColor="var(--board-mask)"
        style={{ background: "var(--ssot-surface)" }}
      />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}

export function Board(props: BoardProps) {
  return (
    <ReactFlowProvider>
      <BoardInner {...props} />
    </ReactFlowProvider>
  );
}
