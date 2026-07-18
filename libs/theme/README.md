# @ssot/theme

Shared design tokens for every SSOT app. The goal is maximum visual consistency
with minimal per-app surgery: apps keep their own component systems but point
all colors, fonts, radii, and control styling at these tokens.

## Usage

In the app entry (JS/TS):

```ts
import '@fontsource-variable/inter'; // self-hosted Inter, no network dependency
import '@ssot/theme/tokens.css';
import '@ssot/theme/header.css';
import '@ssot/theme/controls.css';
```

Then map the app's existing theme layer onto the `--ssot-*` variables:

- Hand-written CSS: replace palette values with `var(--ssot-*)` and control
  styling with the `.ssot-btn` / `.ssot-input` / `.ssot-select` declarations.
- Tailwind v4: reference the variables from `@theme inline`.
- Mantine: point theme colors / `fontFamily` / component sizes at the variables.

## Theming (light default, dark via toggle)

- Light is default: white background. Dark tokens activate under
  `html[data-ssot-theme="dark"]`.
- The shared icon-only toggle is `<ssot-theme-toggle>` from
  `ssot-theme-toggle.js` (served at `/portal-assets/theme/ssot-theme-toggle.js`,
  loaded the same way as `ssot-user.js`). Place it in the header right side,
  directly BEFORE `<ssot-user>`.
- It sets `data-ssot-theme` + `.dark` class + `data-mantine-color-scheme` on
  `<html>` and persists to `localStorage("ssot-theme")` (shared per origin, so
  the choice follows the user across all apps behind the gateway).
- To avoid a first-paint flash, inline this in each page's `<head>` before any
  stylesheets are applied:

```html
<script>(function(){try{var t=localStorage.getItem('ssot-theme')==='dark'?'dark':'light';var r=document.documentElement;r.dataset.ssotTheme=t;r.classList.toggle('dark',t==='dark');r.setAttribute('data-mantine-color-scheme',t);}catch(e){}})();</script>
```

## Typography

One family (Inter Variable), one scale. Use the tokens, not ad-hoc px:
`--ssot-text-xs/sm/md/lg/xl` (12/13/14/16/20) and weights 400 (body),
500 (buttons/labels), 600 (headings). Mono: `--ssot-font-mono`.

## Controls

`controls.css` defines the canonical button/input/select look (height,
radius, border, hover = accent border + accent-soft bg, focus ring,
primary variant). Framework apps replicate the same values inside their
theme instead of adopting the classes — see the comment block in
`controls.css` for the exact spec.

## Rules

- One accent: `--ssot-accent`. Replace app-specific primary colors.
- Domain-specific data colors (chart series, 3D joint palettes, agent badges,
  post-it swatches, the results-sheet DataTable) are NOT tokens - leave as-is.
- Every app renders the shared header (see header.css) with the portal link,
  `<ssot-theme-toggle>`, and `<ssot-user>`.
- Favicon: shared assets in `assets/` (favicon.svg, favicon-96x96.png),
  originally from train-eval-web. The gateway serves them at the origin root;
  apps reference their own public copy for standalone use.
