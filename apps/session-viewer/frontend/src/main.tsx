import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@xyflow/react/dist/style.css";
import "@fontsource-variable/inter";
import "@ssot/theme/tokens.css";
import "@ssot/theme/header.css";
import "@ssot/theme/controls.css";
import "./styles.css";
import App from "./App";

// Shared SSOT chrome (theme toggle + user chip), served by the gateway at
// runtime absolute URLs; absent (404s harmlessly) when the app runs standalone.
// Non-literal specifiers with @vite-ignore so neither Vite nor tsc tries to
// resolve/bundle them at build time.
const ssotThemeToggleSrc = "/portal-assets/theme/ssot-theme-toggle.js";
import(/* @vite-ignore */ ssotThemeToggleSrc).catch(() => {});

const ssotUserSrc = "/portal-assets/theme/ssot-user.js";
import(/* @vite-ignore */ ssotUserSrc).catch(() => {});

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
