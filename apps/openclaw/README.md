# OpenClaw (SSOT app)

Integrates the locally-running OpenClaw agent gateway into the SSOT portal:
watch what the agent is doing, browse session transcripts, and chat with it.

Everything goes through the local `openclaw` CLI (which owns the gateway auth
token). The browser never talks to the OpenClaw gateway directly; the backend
shells out to the CLI and the SSOT gateway proxies the frontend + API.

## Layout

- `backend/` — FastAPI (`@ssot/openclaw-api`), uvicorn on `127.0.0.1:8790`.
- `frontend/` — Vite + React 18 (`@ssot/openclaw-web`), dev port `5175`, base `/openclaw`.

## Backend endpoints

All under `/api`:

- `GET /status` — `openclaw status --json`.
- `GET /sessions` — `openclaw sessions --json --all-agents --limit 100`.
- `GET /sessions/{agent_id}/{session_id}` — parse the on-disk transcript
  (`~/.openclaw/agents/<agent>/sessions/<session>.jsonl`) into ordered turns.
- `GET /logs?limit=N` — non-streaming tail of `openclaw logs --json`.
- `GET /logs/stream` — SSE relay of `openclaw logs --json --follow`; the follower
  subprocess is killed on client disconnect.
- `POST /chat` `{message, session_key?}` — one local agent turn via
  `openclaw agent --json -m <message> [--session-key <key>]`. Never passes
  `--deliver`/`--channel` (those would push to Slack).

## Run

```bash
npx nx install openclaw-api     # uv sync
npx nx dev openclaw-api         # backend on :8790
npx nx dev openclaw-web         # frontend on :5175
```

Under the gateway the app mounts at `/openclaw`. Env knobs (`OPENCLAW_*`,
`SSOT_OPENCLAW_*`) are documented in the repo `.env.example`.
