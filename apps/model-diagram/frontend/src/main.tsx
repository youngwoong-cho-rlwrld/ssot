import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@ssot/theme/tokens.css";
import "@ssot/theme/base.css";
import "@ssot/theme/header.css";
import "@ssot/theme/controls.css";
import "@ssot/theme/chat.css";
import "@ssot/theme/modal.css";
import "@ssot/theme/theme-init.js";
import "@ssot/theme/runtime.js";
import "./styles.css";
import App from "./App";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
