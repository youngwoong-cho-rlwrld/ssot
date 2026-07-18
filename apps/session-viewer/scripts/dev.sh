#!/usr/bin/env bash
# Start the session-board backend (:8787) and frontend (:5173) together.
# Ctrl-C stops both.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cleanup() { kill 0 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "[session-board] backend  -> http://localhost:8787"
( cd "$ROOT/backend" && uv run uvicorn app.main:app --port 8787 --reload ) &

echo "[session-board] frontend -> http://localhost:5173"
( cd "$ROOT/frontend" && npm run dev ) &

wait
