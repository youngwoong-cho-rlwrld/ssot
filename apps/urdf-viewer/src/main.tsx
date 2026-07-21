import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/inter";
import "@ssot/theme/tokens.css";
import "@ssot/theme/base.css";
import "@ssot/theme/header.css";
import "@ssot/theme/controls.css";
import "@ssot/theme/theme-init.js";
import "@ssot/theme/runtime.js";
import { App } from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
