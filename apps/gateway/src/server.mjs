import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { config } from './config.mjs';
import {
  registerAuthRoutes,
  getRequestUser,
  signedOutPage,
  sendUnauthenticated,
  pageShell,
} from './auth.mjs';
import { getSettings } from './db.mjs';
import { registerSettingsRoutes } from './settings.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const app = express();
app.disable('x-powered-by');

// --- portal assets -------------------------------------------------------
const themeDir = path.dirname(require.resolve('@ssot/theme/package.json'));
const interDir = path.dirname(
  require.resolve('@fontsource-variable/inter/package.json')
);
app.use('/portal-assets/theme', express.static(themeDir));
app.use('/portal-assets/inter', express.static(interDir));

// Shared favicon at the origin root, resolved from the @ssot/theme assets.
const faviconSvg = path.join(themeDir, 'assets', 'favicon.svg');
const faviconPng = path.join(themeDir, 'assets', 'favicon-96x96.png');
app.get('/favicon.ico', (_req, res) => {
  res.type('image/png').sendFile(faviconPng);
});
app.get('/favicon.svg', (_req, res) => {
  res.type('image/svg+xml').sendFile(faviconSvg);
});

// --- trust boundary ------------------------------------------------------
// Strip any x-ssot-* headers a client tries to send: downstream apps trust
// these headers as gateway-injected identity, so they must never originate
// from the browser. Runs before every route and proxy.
app.use((req, _res, next) => {
  for (const name of Object.keys(req.headers)) {
    if (name.toLowerCase().startsWith('x-ssot-')) delete req.headers[name];
  }
  // Resolve the signed-in user once per request for downstream injection.
  try {
    req.ssotUser = getRequestUser(req);
  } catch {
    req.ssotUser = null;
  }
  next();
});

// --- auth + account API --------------------------------------------------
registerAuthRoutes(app);

// Derive the guard paths from the same configured mounts as the proxies. This
// keeps auth and settings checks intact when a base path is overridden.
const accountAppIds = new Set([
  'train-eval',
  'results-sheet',
  'session-viewer',
  'openclaw',
  'model-diagram',
]);
const accountApiBases = config.apps
  .filter((entry) => accountAppIds.has(entry.id))
  .map((entry) => ({
    id: entry.id,
    base: entry.apiBase,
  }));

// Account-scoped APIs must never be reached through the network-facing gateway
// without a signed-in session. The standalone upstreams bind to loopback; this
// is the public trust boundary that makes x-ssot-user trustworthy.
app.use((req, res, next) => {
  const apiMount = accountApiBases.find(
    ({ base }) => req.path === base || req.path.startsWith(`${base}/`)
  );
  if (apiMount && !req.ssotUser) {
    return sendUnauthenticated(res);
  }
  if (req.ssotUser && apiMount?.id === 'session-viewer') {
    const roots = getSettings(req.ssotUser.id, 'session-viewer');
    if (!roots.claude_root || !roots.codex_root) {
      return res.status(409).json({ error: 'session_roots_not_configured' });
    }
  }
  next();
});

// --- signed-out page redirect -------------------------------------------
// An unauthenticated DOCUMENT navigation to any app page (or other gateway-served
// page) is bounced to the sign-in form with a next= return param, so the browser
// never loads an app shell whose APIs would only 401. API requests are exempt so
// they keep returning 401 JSON (handled above / by each route); /auth/*, static
// portal assets, and the service-worker killer stay open so the login page and
// its assets render. The root '/' is exempt — it serves the signed-out page below.
const apiBases = config.apps.filter((a) => a.api).map((a) => a.apiBase);
const isApiPath = (p) =>
  p === '/api' ||
  p.startsWith('/api/') ||
  apiBases.some((base) => p === base || p.startsWith(`${base}/`));
const OPEN_EXACT = new Set([
  '/',
  '/favicon.ico',
  '/favicon.svg',
  '/healthz',
  '/sw.js',
  '/service-worker.js',
  '/serviceworker.js',
]);

app.use((req, res, next) => {
  if (req.ssotUser) return next();
  const p = req.path;
  if (
    OPEN_EXACT.has(p) ||
    p.startsWith('/auth/') ||
    p.startsWith('/portal-assets/') ||
    isApiPath(p)
  ) {
    return next();
  }
  // Only bounce document navigations; anything not requesting HTML falls through.
  if (req.method === 'GET' && req.accepts('html')) {
    return res.redirect(`/auth/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
});

app.get('/api/auth/me', (req, res) => {
  const user = req.ssotUser;
  if (!user) return sendUnauthenticated(res);
  const profile = getSettings(user.id, 'profile');
  res.json({
    user: {
      id: user.email,
      email: user.email,
      name: user.name || '',
      picture: user.picture || '',
      username: profile.username || '',
    },
  });
});

const trainEvalApiOrigin = config.apps.find((entry) => entry.id === 'train-eval')?.api?.origin;
async function fetchTrainEvalWandb(pathname, email, init = {}) {
  if (!trainEvalApiOrigin) throw new Error('train-eval API is disabled');
  const response = await fetch(`${trainEvalApiOrigin}/api/wandb/${pathname}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      'x-ssot-user': email,
    },
    signal: AbortSignal.timeout(7000),
  });
  if (!response.ok) throw new Error(`train-eval returned ${response.status}`);
  return response.json();
}
registerSettingsRoutes(app, {
  getWandbStatus: trainEvalApiOrigin
    ? (email) => fetchTrainEvalWandb('status', email)
    : undefined,
  validateWandbKey: trainEvalApiOrigin
    ? (key, email) =>
        fetchTrainEvalWandb('validate', email, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({ key }),
        })
    : undefined,
});

// --- settings page (gateway-served) --------------------------------------
const settingsHtmlPath = path.join(here, '..', 'public', 'settings.html');
app.get('/settings', (req, res) => {
  if (!req.ssotUser) return res.redirect('/auth/login?next=/settings');
  res.sendFile(settingsHtmlPath);
});

app.get('/settings.js', (_req, res) => {
  res.type('application/javascript').sendFile(path.join(here, '..', 'public', 'settings.js'));
});

// Portal page: static template with the app registry injected at boot.
const portalHtml = fs
  .readFileSync(path.join(here, '..', 'public', 'index.html'), 'utf8')
  .replace(
    '__SSOT_APPS_JSON__',
    JSON.stringify(
      config.apps.map(({ id, name, description, basePath }) => ({
        id,
        name,
        description,
        basePath,
      }))
    )
  );

app.get('/', (req, res) => {
  // Signed out: show a minimal "Sign in to continue" page, not the app list.
  if (!req.ssotUser) return res.type('html').send(signedOutPage());
  res.type('html').send(portalHtml);
});

// Service-worker exorcism: a previous app on this origin/port (e.g. a chat
// app) may have registered a service worker that keeps rendering its cached
// UI whenever the gateway is down. Browsers re-fetch the SW script on
// navigation; serving a self-unregistering worker at the common script paths
// permanently evicts such ghosts.
const SW_KILLER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil(
    self.registration.unregister()
      .then(() => self.clients.matchAll({ type: 'window' }))
      .then((clients) => clients.forEach((c) => c.navigate(c.url)))
  );
});
`;
for (const swPath of ['/sw.js', '/service-worker.js', '/serviceworker.js']) {
  app.get(swPath, (_req, res) => {
    res.type('application/javascript').send(SW_KILLER);
  });
}

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', apps: config.apps.map((a) => a.id) });
});

// Upstream status endpoint retained for tooling/monitoring; the portal no
// longer polls it. Any HTTP response counts as "up"; static apps are "up"
// when their build output exists.
app.get('/api/portal/status', async (req, res) => {
  if (!req.ssotUser) return sendUnauthenticated(res);
  const entries = await Promise.all(
    config.apps.map(async (a) => {
      if (a.mode === 'static') {
        const ok = fs.existsSync(path.join(a.staticDir, 'index.html'));
        return [a.id, ok];
      }
      try {
        await fetch(a.origin, {
          method: 'HEAD',
          signal: AbortSignal.timeout(1500),
        });
        return [a.id, true];
      } catch {
        return [a.id, false];
      }
    })
  );
  res.json(Object.fromEntries(entries));
});

// --- host model subscriptions -------------------------------------------
// The agent CLIs (claude, codex) authenticate on THIS host, not in the browser.
// Read only their IDENTITY fields for the settings "General" section — never the
// tokens/secrets. Best-effort: any parse/IO failure reports "logged out".
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function decodeJwtClaims(token) {
  try {
    const segment = String(token).split('.')[1];
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function claudeSubscription() {
  const dir = (process.env.CLAUDE_CONFIG_DIR || '').trim();
  const jsonPath = dir
    ? path.join(dir, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
  const data = readJson(jsonPath);
  const account = data && typeof data.oauthAccount === 'object' ? data.oauthAccount : null;
  if (account) {
    return { email: account.emailAddress || '', status: 'logged_in' };
  }
  return { email: '', status: 'logged_out' };
}

function openaiSubscription() {
  const home = (process.env.CODEX_HOME || '').trim() || path.join(os.homedir(), '.codex');
  const data = readJson(path.join(home, 'auth.json'));
  if (!data) return { email: '', plan: '', status: 'logged_out' };
  // Identity (email + ChatGPT plan) rides in the id_token JWT when the CLI is
  // logged in via ChatGPT; an API-key-only login has neither. auth.json existing
  // means credentials are present either way.
  let email = '';
  let plan = '';
  const claims = data.tokens && data.tokens.id_token ? decodeJwtClaims(data.tokens.id_token) : null;
  if (claims) {
    email = claims.email || '';
    const authClaim = claims['https://api.openai.com/auth'] || {};
    plan = authClaim.chatgpt_plan_type || authClaim.chatgpt_account_plan_type || '';
  }
  return { email, plan, status: 'logged_in' };
}

app.get('/api/portal/subscriptions', (req, res) => {
  if (!req.ssotUser) return sendUnauthenticated(res);
  res.json({
    claude: claudeSubscription(),
    openai: openaiSubscription(),
    hostname: os.hostname(),
  });
});

// --- per-request header injection ---------------------------------------
// Sets trusted x-ssot-* headers on the outbound proxy request from the
// resolved session + that user's stored settings. `scope` selects which
// app-specific headers apply ('results' | 'sessions-api' | null).
function injectHeaders(proxyReq, req, scope) {
  const user = req.ssotUser;
  if (!user) return;
  proxyReq.setHeader('x-ssot-user', user.email);

  if (scope === 'results') {
    const s = getSettings(user.id, 'results-sheet');
    proxyReq.setHeader('x-ssot-results-configs-configured', s.configs_root ? '1' : '0');
    if (s.configs_root) proxyReq.setHeader('x-ssot-results-configs-root', s.configs_root);
  } else if (scope === 'sessions-api') {
    const s = getSettings(user.id, 'session-viewer');
    if (s.claude_root) proxyReq.setHeader('x-ssot-sessions-claude-root', s.claude_root);
    if (s.codex_root) proxyReq.setHeader('x-ssot-sessions-codex-root', s.codex_root);
    if (s.openclaw_root) {
      proxyReq.setHeader('x-ssot-sessions-openclaw-root', s.openclaw_root);
    }
  }
}

// --- per-app mounts ------------------------------------------------------
const wsProxies = [];

for (const a of config.apps) {
  const isSessions = a.id === 'session-viewer';
  const isResults = a.id === 'results-sheet';

  // Backend API for static-mode apps (e.g. /sessions/api/* -> session API's
  // /api/*). Registered before the app mount so it wins.
  if (a.api) {
    const apiBase = a.apiBase;
    app.use(
      createProxyMiddleware({
        pathFilter: (p) => p === apiBase || p.startsWith(apiBase + '/'),
        target: a.api.origin,
        changeOrigin: true,
        pathRewrite: { ['^' + a.basePath]: '' },
        on: {
          proxyReq: (proxyReq, req) =>
            injectHeaders(proxyReq, req, isSessions ? 'sessions-api' : null),
        },
      })
    );
  }

  if (a.mode === 'proxy') {
    // The upstream app serves itself under the same base path, so no rewrite.
    const mw = createProxyMiddleware({
      pathFilter: (p) => p === a.basePath || p.startsWith(a.basePath + '/'),
      target: a.origin,
      ws: false,
      on: {
        proxyReq: (proxyReq, req) =>
          injectHeaders(proxyReq, req, isResults ? 'results' : null),
      },
    });
    app.use(mw);
    if (a.ws) wsProxies.push({ basePath: a.basePath, mw });
  } else {
    app.use(a.basePath, express.static(a.staticDir, { index: 'index.html' }));
    // SPA fallback for client-side routes.
    app.use(a.basePath, (req, res, next) => {
      const indexFile = path.join(a.staticDir, 'index.html');
      if (req.method === 'GET' && fs.existsSync(indexFile)) {
        return res.sendFile(indexFile);
      }
      next();
    });
  }
}

// --- fallback ------------------------------------------------------------
app.use((_req, res) => {
  const styles =
    `<link rel="stylesheet" href="/portal-assets/theme/tokens.css" />` +
    `<style>body{font-family:var(--ssot-font-sans);background:var(--ssot-bg);` +
    `color:var(--ssot-text);min-height:100vh;display:flex;align-items:center;` +
    `justify-content:center;margin:0;font-size:var(--ssot-text-md)}` +
    `a{color:var(--ssot-accent);text-decoration:none}a:hover{text-decoration:underline}</style>`;
  res
    .status(404)
    .type('html')
    .send(
      pageShell({
        title: 'Not found - SSOT',
        styles,
        body: `<p>Not found. <a href="/">SSOT portal</a></p>`,
      })
    );
});

const server = app.listen(config.port, config.host, () => {
  console.log(
    `[ssot-gateway] listening on http://${config.host}:${config.port} ` +
      `(${config.production ? 'production' : 'development'})`
  );
  for (const a of config.apps) {
    console.log(
      `[ssot-gateway]   ${a.basePath}  ->  ${a.mode === 'static' ? a.staticDir : a.origin}`
    );
  }
});

// WebSocket upgrades (Next/Vite HMR in dev). http-proxy-middleware v3 needs
// explicit upgrade wiring; route by path prefix.
server.on('upgrade', (req, socket, head) => {
  const url = req.url ?? '';
  for (const { basePath, mw } of wsProxies) {
    if (url === basePath || url.startsWith(basePath + '/')) {
      mw.upgrade(req, socket, head);
      return;
    }
  }
  socket.destroy();
});
