import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { config, repoRoot } from './config.mjs';
import { registerAuthRoutes, getRequestUser } from './auth.mjs';
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

app.get('/api/auth/me', (req, res) => {
  const user = req.ssotUser;
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  const profile = getSettings(user.id, 'profile');
  const username = profile.username || (user.email ? user.email.split('@')[0] : '');
  res.json({
    user: {
      email: user.email,
      name: user.name || '',
      picture: user.picture || '',
      username,
    },
  });
});

registerSettingsRoutes(app);

// --- settings page (gateway-served) --------------------------------------
const settingsHtml = fs.readFileSync(
  path.join(here, '..', 'public', 'settings.html'),
  'utf8'
);
app.get('/settings', (req, res) => {
  if (!req.ssotUser) return res.redirect('/auth/login?next=/settings');
  res.type('html').send(settingsHtml);
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

app.get('/', (_req, res) => {
  res.type('html').send(portalHtml);
});

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', apps: config.apps.map((a) => a.id) });
});

// Upstream status endpoint retained for tooling/monitoring; the portal no
// longer polls it. Any HTTP response counts as "up"; static apps are "up"
// when their build output exists.
app.get('/api/portal/status', async (_req, res) => {
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
    if (s.configs_root) proxyReq.setHeader('x-ssot-results-configs-root', s.configs_root);
  } else if (scope === 'sessions-api') {
    const s = getSettings(user.id, 'session-viewer');
    if (s.claude_root) proxyReq.setHeader('x-ssot-sessions-claude-root', s.claude_root);
    if (s.codex_root) proxyReq.setHeader('x-ssot-sessions-codex-root', s.codex_root);
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
    const apiBase = a.basePath + a.api.prefix;
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
  res
    .status(404)
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8" />` +
        `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
        `<title>Not found - SSOT</title>` +
        `<script>(function(){try{var t=localStorage.getItem('ssot-theme')==='dark'?'dark':'light';var r=document.documentElement;r.dataset.ssotTheme=t;r.classList.toggle('dark',t==='dark');r.setAttribute('data-mantine-color-scheme',t);}catch(e){}})();</script>` +
        `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />` +
        `<link rel="icon" href="/favicon.ico" type="image/png" />` +
        `<link rel="stylesheet" href="/portal-assets/theme/tokens.css" />` +
        `<style>body{font-family:var(--ssot-font-sans);background:var(--ssot-bg);` +
        `color:var(--ssot-text);min-height:100vh;display:flex;align-items:center;` +
        `justify-content:center;margin:0;font-size:var(--ssot-text-md)}` +
        `a{color:var(--ssot-accent);text-decoration:none}a:hover{text-decoration:underline}</style>` +
        `</head><body><p>Not found. <a href="/">SSOT portal</a></p></body></html>`
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
