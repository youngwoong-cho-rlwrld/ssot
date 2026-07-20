# session-board backend

FastAPI backend that scans Claude Code (`~/.claude/projects/*/*.jsonl`) and Codex
CLI (`~/.codex/sessions/**/*.jsonl`) session files and serves them for a whiteboard
visualizer.

## Run

```bash
cd backend && uv run uvicorn app.main:app --port 8787 --reload
```

The server listens on http://localhost:8787 and allows CORS from the Vite dev
server (http://localhost:5174 and http://127.0.0.1:5174).

## Configuration

- `SESSION_BOARD_ACTIVE_WINDOW` (seconds, default `300`): a session is `active`
  when its file mtime is within this window of now.

## Endpoints

- `GET /api/health` -> `{ status, counts: { claude, codex } }`
- `GET /api/sessions?agent=&project=&q=&since=` -> `Session[]` (sorted by `updated_at` desc)
- `GET /api/sessions/{agent}/{id}` -> `SessionDetail` (404 if not found)
- `GET /api/board` -> `BoardNode[]`
- `PUT /api/board/{uid}` -> upsert/merge a `BoardNode`, persisted to SQLite
- `GET /api/cleanup?categories=system&categories=old` -> group counts and unique affected count
- `DELETE /api/cleanup` with `{ "categories": ["system", "old", "short"] }` -> permanently delete the selected union
- `DELETE /api/sessions/{agent}/{id}` -> move one session to Trash

Board state is stored in `$SSOT_DATA_DIR/ssot.db`. A legacy `backend/board.json`
is imported automatically on first use when present. Session metadata is cached
in the same database by canonical path and file fingerprint, so restarts do not
reparse unchanged transcripts. Filesystem refreshes run single-flight on a
dedicated indexer; list and health requests read root-scoped snapshots without
waiting for transcript parsing.
