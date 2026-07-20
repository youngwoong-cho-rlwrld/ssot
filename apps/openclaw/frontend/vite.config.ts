import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Mounted under a base path on the SSOT gateway (default /openclaw/). In dev the
// gateway proxies to this Vite server, which must serve assets and proxy the API
// under that same prefix so behaviour matches production exactly.
const BASE = process.env.OPENCLAW_BASE_PATH ?? "/openclaw/";
const API_PORT = Number(process.env.OPENCLAW_API_PORT ?? 8790);

// Strip the base prefix (default '/openclaw') before forwarding to the backend,
// mirroring the gateway's pathRewrite so the FastAPI app keeps serving /api/*.
const basePrefix = BASE.replace(/\/$/, "");
const apiPrefix = basePrefix + "/api";
const stripBase = new RegExp("^" + basePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

export default defineConfig({
  base: BASE,
  plugins: [react()],
  server: {
    host: process.env.OPENCLAW_WEB_DEV_HOST ?? "127.0.0.1",
    port: Number(process.env.OPENCLAW_WEB_DEV_PORT ?? 5175),
    strictPort: true,
    proxy: {
      [apiPrefix]: {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        // SSE: disable buffering so /openclaw/api/logs/stream flushes live.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (
              (proxyRes.headers["content-type"] ?? "").includes("text/event-stream")
            ) {
              delete proxyRes.headers["content-length"];
            }
          });
        },
        rewrite: (p) => p.replace(stripBase, ""),
      },
    },
  },
});
