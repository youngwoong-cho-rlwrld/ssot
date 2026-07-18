# SSOT

Single source of truth: one entrypoint for four tools that used to live in
separate repos, unified in an Nx monorepo behind a single gateway origin.

| App | Path | Stack | Project |
|---|---|---|---|
| Portal + gateway | `/` | Node (Express + http-proxy-middleware) | `@ssot/gateway` |
| Train / Eval | `/train-eval` | Next.js 16 + FastAPI | `@ssot/train-eval-web`, `@ssot/train-eval-api` |
| Results Sheet | `/results` | Next.js 16 + Mantine | `@ssot/results-sheet` |
| URDF Viewer | `/urdf` | Vite + React + three.js (static) | `@ssot/urdf-viewer` |
| Session Viewer | `/sessions` | Vite + React + FastAPI | `@ssot/session-viewer-web`, `@ssot/session-viewer-api` |

Shared design tokens live in `libs/theme` (Inter Variable, light theme, one
accent). Every app maps its own theme layer onto the `--ssot-*` variables and
renders the shared SSOT header linking back to the portal.

## Prerequisites

- Node >= 24 (results-sheet requires it), npm
- Python >= 3.11 and [uv](https://docs.astral.sh/uv/) (the two FastAPI backends)
- Runtime-only: SSH access + slurm/kubectl for train-eval's cluster features

## Quickstart

```bash
npm install
npx nx run @ssot/train-eval-api:install      # uv sync
npx nx run @ssot/session-viewer-api:install  # uv sync
cp .env.example .env                         # optional; defaults work locally

npm run dev        # everything, in parallel
open http://localhost:4000
```

`npm run dev` starts the gateway (:4000) plus all apps on their standalone
ports (train-eval web :3000, api :8000, results :3001, urdf :5173, session web
:5174, api :8787). The gateway proxies each under its base path, so both
`http://localhost:4000/results` and `http://localhost:3001/results` work.

Run a single app: `npx nx dev <project>` (see table above).

## Production

```bash
npm run build                 # builds Next apps + Vite dists
SSOT_ENV=production npm run start
```

In production mode the gateway serves the two Vite apps statically from their
`dist/` directories and proxies the Next servers and FastAPI backends. Any
process manager (systemd, pm2, tmux) can own `npm run start`; there is no
git-pull-on-box deploy logic left in any app.

## Configuration

Everything is configurable through environment variables; `.env.example`
documents every knob with its default. Nx injects the root `.env` into all
tasks, and the gateway reads it directly as a fallback. Highlights:

- `SSOT_HOST` / `SSOT_PORT` - gateway bind (default 0.0.0.0:4000).
- `SSOT_<APP>_ORIGIN` - where the gateway finds each app.
- `SSOT_<APP>_BASE_PATH` - mount point on the gateway origin.
- `SSOT_<APP>_ENABLED` - hide an app from the portal and gateway.
- `SSOT_CONFIG` - optional JSON file overriding the app registry (names,
  descriptions, origins, base paths) without touching env or code.
- `SSOT_DATA_DIR` - SQLite location (`~/.ssot/ssot.db` by default). The only
  persistent SSOT state (session-viewer board layout) lives there; a legacy
  `board.json` is imported automatically on first run.
- Per-app variables (ports, upstream API bases, scan roots, CORS) are listed
  in `.env.example` under their app's section.

## User management

The gateway owns sign-in and per-user settings for the whole suite.

**Email sign-in.** Sign-in is no-password: `/auth/login` shows a single email
field, and whoever enters an allowed email is signed in as that user (name
defaults to the email local part). There is no password or external identity
provider. Set `SSOT_ALLOWED_EMAIL_DOMAINS` (comma-separated) to restrict who
may sign in; leaving it empty allows any email. `SSOT_PUBLIC_URL` marks the
session cookie `Secure` when it is https, and `SSOT_SESSION_TTL_DAYS` sets the
session lifetime. See the "auth / user management" block in `.env.example`.

Because identity is trust-based (anyone who knows an allowed email can sign in
as that person), run the gateway only on a trusted network and treat
`SSOT_ALLOWED_EMAIL_DOMAINS` as the primary access gate.

**Settings page** (`/settings`, gateway-served) lets a signed-in user edit:
their username; the train-eval cluster environment settings, Weights & Biases,
and Slack notifications (pushed to the train-eval API on save, and prefilled
from it otherwise); the results-sheet configs root; and the session-viewer
Claude/Codex session roots.

**`x-ssot-*` header contract.** On every proxied request that carries a valid
session, the gateway injects `x-ssot-user` (the signed-in email) for all apps,
`x-ssot-results-configs-root` on `/results` requests, and
`x-ssot-sessions-claude-root` / `x-ssot-sessions-codex-root` on `/sessions/api`
requests (each only when the user has set it). Any client-supplied `x-ssot-*`
header is stripped before proxying, so apps can trust these as
gateway-asserted identity.

> **Security note.** Because backends trust the gateway-injected `x-ssot-*`
> headers, they must bind to `127.0.0.1` and must not be exposed directly.
> Reaching a backend without going through the gateway would let a client
> forge identity. Only the gateway should be publicly reachable.

## Repo layout

```
apps/
  gateway/            portal page + reverse proxy (the single entrypoint)
  train-eval/         frontend/ (Next), backend/ (FastAPI), configs/, lib/
  results-sheet/      Next app, reads train-eval's results API
  urdf-viewer/        static Vite SPA
  session-viewer/     frontend/ (Vite), backend/ (FastAPI)
libs/
  theme/              shared design tokens, header styles, Inter font dep
```
