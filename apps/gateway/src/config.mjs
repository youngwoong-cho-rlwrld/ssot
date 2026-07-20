import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..', '..');

// Load the workspace-root .env without overriding variables that the shell
// (or Nx, which injects root .env into tasks) already set.
function loadDotenv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotenv(path.join(repoRoot, '.env'));

const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};

const production = env('SSOT_ENV', env('NODE_ENV', 'development')) === 'production';

// Default origins match each app's historical standalone port so existing
// habits and configs keep working; every one is overridable via env.
const apps = [
  {
    id: 'train-eval',
    name: 'Train / Eval',
    description: 'Submit and monitor training and evaluation jobs across clusters.',
    basePath: env('SSOT_TRAIN_EVAL_BASE_PATH', '/train-eval'),
    mode: 'proxy',
    origin: env('SSOT_TRAIN_EVAL_ORIGIN', 'http://127.0.0.1:3000'),
    // Route the API at the gateway instead of relying on the Next rewrite:
    // Next bakes rewrite destinations into the build (routes-manifest.json),
    // so only this keeps the API origin runtime-configurable.
    api: {
      origin: env('SSOT_TRAIN_EVAL_API_ORIGIN', 'http://127.0.0.1:8000'),
      prefix: '/api',
    },
    ws: true,
    enabled: env('SSOT_TRAIN_EVAL_ENABLED', 'true') !== 'false',
  },
  {
    id: 'results-sheet',
    name: 'Results Sheet',
    description: 'Explore evaluation results in tables and charts.',
    basePath: env('SSOT_RESULTS_BASE_PATH', '/results'),
    mode: 'proxy',
    origin: env('SSOT_RESULTS_ORIGIN', 'http://127.0.0.1:3001'),
    ws: true,
    enabled: env('SSOT_RESULTS_ENABLED', 'true') !== 'false',
  },
  {
    id: 'urdf-viewer',
    name: 'URDF Viewer',
    description: 'Inspect robots and episode trajectories in 3D.',
    basePath: env('SSOT_URDF_BASE_PATH', '/urdf'),
    mode: production ? 'static' : 'proxy',
    origin: env('SSOT_URDF_DEV_ORIGIN', 'http://127.0.0.1:5173'),
    staticDir: env('SSOT_URDF_DIST', path.join(repoRoot, 'apps/urdf-viewer/dist')),
    ws: true,
    enabled: env('SSOT_URDF_ENABLED', 'true') !== 'false',
  },
  {
    id: 'session-viewer',
    name: 'Session Viewer',
    description: 'Browse and organize coding-agent session transcripts.',
    basePath: env('SSOT_SESSIONS_BASE_PATH', '/sessions'),
    mode: production ? 'static' : 'proxy',
    origin: env('SSOT_SESSIONS_WEB_DEV_ORIGIN', 'http://127.0.0.1:5174'),
    staticDir: env(
      'SSOT_SESSIONS_DIST',
      path.join(repoRoot, 'apps/session-viewer/frontend/dist')
    ),
    api: {
      origin: env('SSOT_SESSIONS_API_ORIGIN', 'http://127.0.0.1:8787'),
      prefix: '/api',
    },
    ws: true,
    enabled: env('SSOT_SESSIONS_ENABLED', 'true') !== 'false',
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    description: 'Watch the local OpenClaw agent, browse its sessions, and chat with it.',
    basePath: env('SSOT_OPENCLAW_BASE_PATH', '/openclaw'),
    mode: production ? 'static' : 'proxy',
    origin: env('SSOT_OPENCLAW_WEB_DEV_ORIGIN', 'http://127.0.0.1:5175'),
    staticDir: env(
      'SSOT_OPENCLAW_DIST',
      path.join(repoRoot, 'apps/openclaw/frontend/dist')
    ),
    api: {
      origin: env('SSOT_OPENCLAW_API_ORIGIN', 'http://127.0.0.1:8790'),
      prefix: '/api',
    },
    ws: true,
    enabled: env('SSOT_OPENCLAW_ENABLED', 'true') !== 'false',
  },
];

// Optional JSON override file for anything above: { host, port, apps: { <id>:
// { name, description, basePath, origin, staticDir, enabled } } }.
// Lets a deployment reconfigure the portal without touching code or env.
let fileOverrides = {};
const configFile = env('SSOT_CONFIG', path.join(repoRoot, 'ssot.config.json'));
try {
  fileOverrides = JSON.parse(fs.readFileSync(configFile, 'utf8'));
} catch {
  fileOverrides = {};
}
for (const a of apps) {
  Object.assign(a, fileOverrides.apps?.[a.id] ?? {});
  const mount = String(a.basePath || '/').trim();
  a.basePath = (mount.startsWith('/') ? mount : `/${mount}`).replace(/\/+$/, '') || '/';
  const apiPrefix = String(a.api?.prefix || '/api').trim();
  const normalizedApiPrefix = (apiPrefix.startsWith('/') ? apiPrefix : `/${apiPrefix}`)
    .replace(/\/+$/, '') || '/api';
  if (a.api) a.api.prefix = normalizedApiPrefix;
  a.apiBase = `${a.basePath === '/' ? '' : a.basePath}${normalizedApiPrefix}`;
}

export const config = {
  host: fileOverrides.host ?? env('SSOT_HOST', '0.0.0.0'),
  port: Number(fileOverrides.port ?? env('SSOT_PORT', '4000')),
  production,
  apps: apps.filter((a) => a.enabled),
};
