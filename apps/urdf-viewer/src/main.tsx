import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@ssot/theme/tokens.css";
import "@ssot/theme/header.css";
import "@ssot/theme/controls.css";
import { App } from "./App";
import "./styles.css";

// Shared SSOT chrome, served by the gateway; absent when standalone.
// Non-literal specifiers so neither Vite nor tsc tries to resolve them.
const ssotThemeToggleSrc = "/portal-assets/theme/ssot-theme-toggle.js";
import(/* @vite-ignore */ ssotThemeToggleSrc).catch(() => {});
const ssotUserSrc = "/portal-assets/theme/ssot-user.js";
import(/* @vite-ignore */ ssotUserSrc).catch(() => {});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
