import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app is mounted under a base path on the SSOT gateway (default /sessions/).
// In dev, the gateway proxies to the Vite server, which must serve assets and
// proxy the API under that same prefix so behaviour matches production exactly.
const BASE = process.env.SESSIONS_BASE_PATH ?? "/sessions/";
const API_PORT = Number(process.env.SESSIONS_API_PORT ?? 8787);

// Strip the base prefix (default '/sessions') before forwarding to the backend,
// mirroring the gateway's pathRewrite so the FastAPI app keeps serving /api/*.
const basePrefix = BASE.replace(/\/$/, "");
const apiPrefix = basePrefix + "/api";
const stripBase = new RegExp("^" + basePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

export default defineConfig({
  base: BASE,
  plugins: [react()],
  server: {
    host: process.env.SESSIONS_WEB_DEV_HOST ?? "127.0.0.1",
    port: Number(process.env.SESSIONS_WEB_DEV_PORT ?? 5174),
    strictPort: true,
    proxy: {
      [apiPrefix]: {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(stripBase, ""),
      },
    },
  },
});
