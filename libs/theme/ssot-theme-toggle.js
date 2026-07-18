/*
 * <ssot-theme-toggle> - icon-only light/dark toggle, shared by every SSOT app.
 * Served by the gateway at /portal-assets/theme/ssot-theme-toggle.js.
 *
 * Applies the theme by setting, on <html>:
 *   - data-ssot-theme="light|dark"   (drives the --ssot-* token overrides)
 *   - class "dark"                    (Tailwind class-based dark variant)
 *   - data-mantine-color-scheme       (Mantine components)
 * Persists to localStorage("ssot-theme") and syncs across tabs. To avoid a
 * flash of the wrong theme, pages should also inline the tiny init snippet
 * documented in libs/theme/README.md (this module re-applies on load anyway).
 */
const STORAGE_KEY = 'ssot-theme';

const SUN =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
const MOON =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';

function currentTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  root.dataset.ssotTheme = theme;
  root.classList.toggle('dark', theme === 'dark');
  root.setAttribute('data-mantine-color-scheme', theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode etc.; theme still applies for this page */
  }
}

class SsotThemeToggle extends HTMLElement {
  connectedCallback() {
    if (this.__init) return;
    this.__init = true;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = [
      'display:inline-flex',
      'align-items:center',
      'justify-content:center',
      'width:28px',
      'height:28px',
      'padding:0',
      'border:none',
      'border-radius:50%',
      'background:transparent',
      'color:var(--ssot-text-soft)',
      'cursor:pointer',
      'transition:background-color 120ms ease,color 120ms ease',
    ].join(';');
    btn.addEventListener('mouseenter', () => {
      btn.style.backgroundColor = 'var(--ssot-accent-soft)';
      btn.style.color = 'var(--ssot-accent)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.backgroundColor = 'transparent';
      btn.style.color = 'var(--ssot-text-soft)';
    });
    btn.addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      this.render(btn);
    });
    this.appendChild(btn);

    // Re-apply on load (covers pages without the inline init snippet) and
    // follow changes made in other tabs.
    applyTheme(currentTheme());
    this.render(btn);
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY) {
        applyTheme(currentTheme());
        this.render(btn);
      }
    });
  }

  render(btn) {
    const theme = currentTheme();
    btn.innerHTML = theme === 'dark' ? SUN : MOON;
    btn.setAttribute(
      'aria-label',
      theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
    );
    btn.title = btn.getAttribute('aria-label');
  }
}

if (!customElements.get('ssot-theme-toggle')) {
  customElements.define('ssot-theme-toggle', SsotThemeToggle);
}
