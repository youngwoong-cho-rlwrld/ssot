// Tiny cookie helpers so we do not pull in cookie-parser as a new dependency.

export function parseCookies(req) {
  const header = req.headers?.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const seg = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) seg.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.expires) seg.push(`Expires=${opts.expires.toUTCString()}`);
  seg.push(`Path=${opts.path || '/'}`);
  if (opts.httpOnly) seg.push('HttpOnly');
  if (opts.secure) seg.push('Secure');
  seg.push(`SameSite=${opts.sameSite || 'Lax'}`);
  return seg.join('; ');
}

export function appendSetCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', cookie);
  else res.setHeader('Set-Cookie', [].concat(prev, cookie));
}
