# Results Sheet Viewer

Standalone Next.js viewer for `train-eval-web` results.

Requires Node.js 24 or newer.

## Run

```sh
cd ../train-eval-web && ./scripts/run.sh
cd ../results-sheet-viewer
npm ci
npm run dev
```

Open `http://localhost:3001`.

For another device on the same network, open `http://<this-machine-ip>:3001`.

## Inputs

- `RESULTS_API_BASE`: results API. Default: `http://127.0.0.1:8000`
- `RESULTS_CONFIGS_ROOT`: experiment configs. Default: `../train-eval-web/configs/experiments`
- `RESULTS_CLUSTER_TIMEOUT_MS`: per-cluster proxy timeout. Default: `195000`

## Agent

```sh
export AGENT_TOKEN="$(openssl rand -hex 32)"
printf 'Agent token: %s\n' "$AGENT_TOKEN"
APP_DIR="$PWD" sh -lc 'tmux new-session -d -s results-agent -n chat "cd \"$APP_DIR\" && claude" && tmux split-window -h -t results-agent:0 "cd \"$APP_DIR\" && AGENT_TOKEN=\"$AGENT_TOKEN\" AGENT_TMUX_TARGET=results-agent:0.0 npm run agent" && tmux select-pane -t results-agent:0.0 && tmux attach -t results-agent'
```

Use `http://localhost:3011` and the printed token in the app. The agent binds to
loopback by default. If another device must connect, expose it deliberately with
`AGENT_HOST=0.0.0.0`, use a fresh random token, and restrict port 3011 at the firewall.

The agent accepts a single request at a time. Request size limits can be adjusted with
`AGENT_MAX_REQUEST_BODY_BYTES`, `AGENT_MAX_MESSAGE_BYTES`, and
`AGENT_MAX_CONTEXT_BYTES`. Stale request contexts are removed after 24 hours by default;
adjust this with `AGENT_CONTEXT_MAX_AGE_MS`. Request bodies must arrive within 15 seconds;
adjust this with `AGENT_REQUEST_BODY_TIMEOUT_MS`.

## Verify

```sh
npm run check
```

This runs the strict TypeScript check, focused domain/view-state tests, and a production build.
