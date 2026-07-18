# session-board

Local whiteboard for tracking your Claude Code and Codex CLI sessions. Every
session shows up as a draggable post-it on an infinite canvas; click one to read
its full transcript. Position, color, star, and note persist across reloads.

## What it reads (read-only)

- Claude: `~/.claude/projects/*/*.jsonl`
- Codex:  `~/.codex/sessions/**/*.jsonl`

The only file the app writes is `backend/board.json` (your post-it layout and
annotations). It never modifies your session files.

## Prerequisites

- Python 3.11+ with `uv` (https://docs.astral.sh/uv/)
- Node 18+ with `npm`

## Run

Backend (terminal 1):

    cd backend
    uv run uvicorn app.main:app --port 8787 --reload

Frontend (terminal 2):

    cd frontend
    npm install        # first time only
    npm run dev

Then open http://localhost:5173 .

Or start both at once:

    npm install --prefix frontend   # first time only
    ./scripts/dev.sh

## Layout

- `backend/`  FastAPI: scans and parses session files, serves `/api`, persists `board.json`.
- `frontend/` Vite + React + react-flow whiteboard.

## Notes

- The "active" pulse marks sessions whose file changed within the last 5 minutes
  (tunable via `SESSION_BOARD_ACTIVE_WINDOW`, in seconds).
- Resume a session from its detail panel:
  - Claude: `cd <cwd> && claude --resume <id>`
  - Codex:  `codex resume <id>`
