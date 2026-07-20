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

Use the SSOT gateway for access from another device. The standalone Results
server binds to loopback by default because its authenticated chat routes can
reach the local OpenClaw agent.

## Inputs

- `RESULTS_API_BASE`: results API. Default: `http://127.0.0.1:8000`
- `RESULTS_CONFIGS_ROOT`: experiment configs. Default: `../train-eval-web/configs/experiments`
- `RESULTS_CLUSTER_TIMEOUT_MS`: per-cluster proxy timeout. Default: `195000`
- `OPENCLAW_API_BASE`: OpenClaw API used by Results chat. Default: `http://127.0.0.1:8790`
- `OPENCLAW_CHAT_TIMEOUT_MS`: OpenClaw proxy timeout. Default: `140000`

## Chat

Results chat uses the SSOT OpenClaw backend. The model selector lists OpenClaw's
configured models and applies the selected model only to this Results chat.

## Verify

```sh
npm run check
```

This runs the strict TypeScript check, focused domain/view-state tests, and a production build.
