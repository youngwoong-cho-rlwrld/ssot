// Apply the persisted scheme as early as possible. This file is deliberately a
// classic-script-compatible IIFE so gateway and Next.js pages can load it in
// <head>, while Vite apps may import it from their browser entrypoint.
(function initSsotTheme() {
  if (typeof document === 'undefined') return;
  try {
    const theme = localStorage.getItem('ssot-theme') === 'dark' ? 'dark' : 'light';
    const root = document.documentElement;
    root.dataset.ssotTheme = theme;
    root.classList.toggle('dark', theme === 'dark');
    root.setAttribute('data-mantine-color-scheme', theme);
  } catch {
    // Storage may be unavailable; the light token defaults remain valid.
  }
})();
