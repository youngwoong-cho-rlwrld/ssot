import { useCallback, useMemo, useState } from "react";
import { Toolbar } from "./board/Toolbar";
import { Board } from "./board/Board";
import { TranscriptPanel } from "./detail/TranscriptPanel";
import { useSessions } from "./hooks/useSessions";
import { useBoard } from "./hooks/useBoard";
import {
  filterSessions,
  initialFilterState,
  maxMessagesOf,
  projectsOf,
  type FilterState,
} from "./board/filters";

export default function App() {
  const { sessions, loading, error, refresh, removeLocal } = useSessions();
  const { board, updateNode, removeNode } = useBoard();
  const [filters, setFilters] = useState<FilterState>(initialFilterState);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [cleanupHighlightedUids, setCleanupHighlightedUids] = useState<
    ReadonlySet<string>
  >(() => new Set());

  const projects = useMemo(() => projectsOf(sessions), [sessions]);
  const maxMessages = useMemo(() => maxMessagesOf(sessions), [sessions]);

  const filtered = useMemo(
    () => filterSessions(sessions, filters),
    [sessions, filters],
  );

  const onApplyFilters = useCallback((next: FilterState) => setFilters(next), []);

  const onCleanupHighlight = useCallback((uids: string[]) => {
    setCleanupHighlightedUids(new Set(uids));
  }, []);

  const onMoveNode = useCallback(
    (uid: string, x: number, y: number) => updateNode(uid, { x, y }),
    [updateNode],
  );

  const onToggleStar = useCallback(
    (uid: string) => {
      const current = board.get(uid)?.starred ?? false;
      updateNode(uid, { starred: !current });
    },
    [board, updateNode],
  );

  const onDeleted = useCallback(
    (uid: string) => {
      removeLocal(uid);
      removeNode(uid);
      setSelectedUid(null);
    },
    [removeLocal, removeNode],
  );

  const selected = useMemo(
    () => sessions.find((s) => s.uid === selectedUid) ?? null,
    [sessions, selectedUid],
  );

  const portalUrl = import.meta.env.VITE_SSOT_PORTAL_URL ?? "/";

  return (
    <div className="app">
      <header className="ssot-header">
        <a className="ssot-brand" href={portalUrl}>
          SSOT
        </a>
        <span className="ssot-sep">/</span>
        <span className="ssot-app-name">Session Viewer</span>
        <span className="ssot-header-spacer"></span>
        <ssot-theme-toggle></ssot-theme-toggle>
        <ssot-user></ssot-user>
      </header>

      <Toolbar
        filters={filters}
        onApply={onApplyFilters}
        projects={projects}
        sessions={sessions}
        maxMessages={maxMessages}
        onCleaned={refresh}
        onCleanupHighlight={onCleanupHighlight}
      />

      <main className="app__board">
        {error && (
          <div className="app__banner app__banner--err">
            Failed to load sessions: {error}
          </div>
        )}
        {loading && sessions.length === 0 && !error && (
          <div className="app__banner">Loading sessions...</div>
        )}
        {!loading && sessions.length === 0 && !error && (
          <div className="app__banner">No sessions found.</div>
        )}
        <Board
          sessions={filtered}
          board={board}
          selectedUid={selectedUid}
          highlightedUids={cleanupHighlightedUids}
          onSelect={setSelectedUid}
          onMoveNode={onMoveNode}
          onToggleStar={onToggleStar}
        />
      </main>

      {selected && (
        <TranscriptPanel
          key={selected.uid}
          agent={selected.agent}
          id={selected.id}
          uid={selected.uid}
          node={board.get(selected.uid)}
          onClose={() => setSelectedUid(null)}
          onUpdateNode={updateNode}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}
