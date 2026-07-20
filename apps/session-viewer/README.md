# session-board

Local whiteboard for tracking your Claude Code and Codex CLI sessions. Every
session shows up as a draggable post-it on an infinite canvas; click one to read
its transcript. Position, color, star, and note persist across reloads. The
cleanup panel can permanently remove cron, older-than-14-days, and
fewer-than-10-chat sessions represented by dashboard cards. Option counts and
selected totals use the same card identities shown on the board.

## What it reads

- Claude: `~/.claude/projects/*/*.jsonl`
- Codex:  `~/.codex/sessions/**/*.jsonl`

Board layout and annotations are stored in the shared SSOT SQLite database.
Session files are only modified after an explicit action. Single-session Delete
moves its JSONL file to the operating system Trash; Clean up permanently removes
the selected JSONL files.

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

- `backend/`  FastAPI: indexes session files, serves `/api`, and persists board and metadata caches in SQLite.
- `frontend/` Vite + React + react-flow whiteboard.

## Notes

- The "active" pulse marks sessions whose file changed within the last 5 minutes
  (tunable via `SESSION_BOARD_ACTIVE_WINDOW`, in seconds).
- Resume a session from its detail panel:
  - Claude: `cd <cwd> && claude --resume <id>`
  - Codex:  `codex resume <id>`
