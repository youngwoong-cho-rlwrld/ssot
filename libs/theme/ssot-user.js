/*
 * <ssot-user> - compact account chip shared across every SSOT app.
 *
 * Zero dependencies, plain ES module. Colors come from the --ssot-* design
 * tokens (tokens.css) so it matches whatever surface it is dropped into.
 *
 * Attributes:
 *   settings-url  where the chip links when signed in (default "/settings")
 *   login-url     where the "Sign in" link points     (default "/auth/login")
 *
 * Behavior: fetches /api/auth/me (same-origin). On 200 it renders an avatar +
 * username chip linking to settings-url; on 401 it renders a "Sign in" link;
 * on any network/parse error it renders nothing, since apps also run
 * standalone where these endpoints do not exist.
 */
class SsotUser extends HTMLElement {
  connectedCallback() {
    this._render();
  }

  get settingsUrl() {
    return this.getAttribute('settings-url') || '/settings';
  }

  get loginUrl() {
    return this.getAttribute('login-url') || '/auth/login';
  }

  async _render() {
    let user = null;
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (res.status === 401) {
        this._renderSignIn();
        return;
      }
      if (!res.ok) {
        this.replaceChildren();
        return;
      }
      const data = await res.json();
      user = data && data.user;
      if (!user) {
        this.replaceChildren();
        return;
      }
    } catch {
      // Network error or non-JSON: render nothing (standalone mode).
      this.replaceChildren();
      return;
    }
    this._renderChip(user);
  }

  _baseStyle() {
    return `
      display:inline-flex;align-items:center;gap:8px;
      padding:4px 10px 4px 4px;border-radius:999px;
      border:1px solid var(--ssot-border,#e4e7ec);
      background:var(--ssot-surface,#fff);
      color:var(--ssot-text,#1c2130);
      font-family:var(--ssot-font-sans,system-ui,sans-serif);
      font-size:13px;font-weight:500;line-height:1;
      text-decoration:none;cursor:pointer;
    `;
  }

  _renderSignIn() {
    const a = document.createElement('a');
    a.href = this.loginUrl;
    a.textContent = 'Sign in';
    a.style.cssText =
      this._baseStyle() + ';padding:6px 12px;color:var(--ssot-accent,#4f6ef7);';
    this.replaceChildren(a);
  }

  _renderChip(user) {
    const a = document.createElement('a');
    a.href = this.settingsUrl;
    a.title = user.email || user.username || 'Account';
    a.style.cssText = this._baseStyle();

    const avatar = this._avatar(user);
    const label = document.createElement('span');
    label.textContent = user.username || (user.email ? user.email.split('@')[0] : 'Account');
    label.style.cssText = 'max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    a.replaceChildren(avatar, label);
    this.replaceChildren(a);
  }

  _avatar(user) {
    const size = 24;
    if (user.picture) {
      const img = document.createElement('img');
      img.src = user.picture;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;display:block;`;
      return img;
    }
    // Colored initial fallback, hue derived from the identity string.
    const seed = user.username || user.email || '?';
    const initial = (seed.trim()[0] || '?').toUpperCase();
    const hue = Array.from(seed).reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
    const badge = document.createElement('span');
    badge.textContent = initial;
    badge.style.cssText =
      `width:${size}px;height:${size}px;border-radius:50%;display:inline-flex;` +
      `align-items:center;justify-content:center;font-size:12px;font-weight:600;` +
      `color:#fff;background:hsl(${hue} 55% 52%);flex:none;`;
    return badge;
  }
}

if (!customElements.get('ssot-user')) {
  customElements.define('ssot-user', SsotUser);
}
