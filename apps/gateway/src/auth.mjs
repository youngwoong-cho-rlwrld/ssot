import crypto from 'node:crypto';
import express from 'express';
import {
  upsertUser,
  createSession,
  getSessionUser,
  deleteSession,
  purgeExpiredSessions,
} from './db.mjs';
import { parseCookies, serializeCookie, appendSetCookie } from './cookies.mjs';

export const SESSION_COOKIE = 'ssot_session';

const env = (k, d) => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};

const authConfig = () => {
  const publicUrl = env('SSOT_PUBLIC_URL', 'http://localhost:4000').replace(/\/+$/, '');
  return {
    publicUrl,
    allowedDomains: env('SSOT_ALLOWED_EMAIL_DOMAINS', '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    ttlDays: Number(env('SSOT_SESSION_TTL_DAYS', '30')) || 30,
    secure: publicUrl.startsWith('https://'),
  };
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const domainOf = (email) => (email.split('@')[1] || '').toLowerCase();

// Deliberately permissive single-@ email shape check; domain allowlisting is
// the real gate.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function domainAllowed(cfg, email) {
  if (cfg.allowedDomains.length === 0) return true;
  return cfg.allowedDomains.includes(domainOf(email));
}

// Look up the signed-in user for a request from its session cookie.
export function getRequestUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  return getSessionUser(sha256(token));
}

function issueSession(res, cfg, user) {
  const raw = crypto.randomBytes(32).toString('base64url');
  createSession(sha256(raw), user.id, cfg.ttlDays);
  appendSetCookie(
    res,
    serializeCookie(SESSION_COOKIE, raw, {
      httpOnly: true,
      secure: cfg.secure,
      sameSite: 'Lax',
      path: '/',
      maxAge: cfg.ttlDays * 86400,
    })
  );
}

function safeNext(next) {
  // Only allow same-origin absolute paths to prevent open redirects.
  if (typeof next === 'string' && next.startsWith('/') && !next.startsWith('//')) {
    return next;
  }
  return '/';
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);

function loginPage({ cfg, next, error, email }) {
  const domains = cfg.allowedDomains;
  const hint =
    domains.length === 0
      ? ''
      : `<p class="hint">Use your ${domains
          .map((d) => '@' + escapeHtml(d))
          .join(' or ')} email.</p>`;
  const err = error ? `<p class="err">${escapeHtml(error)}</p>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Sign in - SSOT</title>
<script>(function(){try{var t=localStorage.getItem('ssot-theme')==='dark'?'dark':'light';var r=document.documentElement;r.dataset.ssotTheme=t;r.classList.toggle('dark',t==='dark');r.setAttribute('data-mantine-color-scheme',t);}catch(e){}})();</script>
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon.ico" type="image/png" />
<link rel="stylesheet" href="/portal-assets/theme/tokens.css" />
<link rel="stylesheet" href="/portal-assets/theme/controls.css" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--ssot-font-sans); background: var(--ssot-bg); color: var(--ssot-text);
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 360px; background: var(--ssot-surface);
    border: 1px solid var(--ssot-border); border-radius: var(--ssot-radius);
    box-shadow: var(--ssot-shadow); padding: 32px 28px; }
  .brand { font-size: var(--ssot-text-xl); font-weight: var(--ssot-weight-semibold); letter-spacing: 0.12em; text-align: center; }
  .sub { margin-top: 6px; text-align: center; color: var(--ssot-text-soft); font-size: var(--ssot-text-sm); }
  form { margin-top: 24px; }
  label { display: block; font-size: var(--ssot-text-xs); font-weight: var(--ssot-weight-semibold); color: var(--ssot-text-soft); margin-bottom: 6px; }
  .card .ssot-input { width: 100%; }
  .card .ssot-btn { margin-top: 16px; width: 100%; }
  .hint { margin-top: 12px; text-align: center; font-size: var(--ssot-text-xs); color: var(--ssot-text-faint); }
  .err { margin-top: 14px; font-size: var(--ssot-text-sm); color: var(--ssot-danger);
    background: var(--ssot-danger-soft); border-radius: var(--ssot-radius-sm); padding: 8px 10px; }
</style></head>
<body><div class="card">
  <div class="brand">SSOT</div>
  <div class="sub">Sign in to continue</div>
  ${err}
  <form method="POST" action="/auth/login">
    <input type="hidden" name="next" value="${escapeHtml(next)}" />
    <label for="email">Email</label>
    <input type="email" id="email" name="email" class="ssot-input" autocomplete="email" autofocus
      required value="${escapeHtml(email || '')}" placeholder="you@example.com" />
    <button type="submit" class="ssot-btn ssot-btn-primary">Sign in</button>
  </form>
  ${hint}
</div></body></html>`;
}

// Registers /auth/login (GET form + POST submit) and /auth/logout.
export function registerAuthRoutes(app) {
  const formBody = [
    express.urlencoded({ extended: false, limit: '16kb' }),
    express.json({ limit: '16kb' }),
  ];

  app.get('/auth/login', (req, res) => {
    const cfg = authConfig();
    const next = safeNext(req.query.next);
    res.type('html').send(loginPage({ cfg, next, error: null, email: '' }));
  });

  app.post('/auth/login', ...formBody, (req, res) => {
    const cfg = authConfig();
    const body = req.body || {};
    const next = safeNext(body.next);
    const email = String(body.email || '').trim().toLowerCase();

    const render = (error, status) =>
      res.status(status).type('html').send(loginPage({ cfg, next, error, email }));

    if (!EMAIL_RE.test(email)) {
      return render('Please enter a valid email address.', 400);
    }
    if (!domainAllowed(cfg, email)) {
      const allowed = cfg.allowedDomains.map((d) => '@' + d).join(' or ');
      return render(`That email is not allowed. Use your ${allowed} email.`, 403);
    }

    const user = upsertUser({ email, name: email.split('@')[0], picture: null });
    issueSession(res, cfg, user);
    purgeExpiredSessions();
    res.redirect(next);
  });

  app.post('/auth/logout', (req, res) => {
    const cfg = authConfig();
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) deleteSession(sha256(token));
    appendSetCookie(
      res,
      serializeCookie(SESSION_COOKIE, '', {
        httpOnly: true,
        secure: cfg.secure,
        sameSite: 'Lax',
        path: '/',
        maxAge: 0,
      })
    );
    res.status(204).end();
  });
}
