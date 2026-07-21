import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app is mounted under a base path on the SSOT gateway (default
// /model-diagram/). In dev, the gateway proxies to this Vite server, which
// must serve assets and proxy the API under that same prefix so behaviour
// matches production exactly.
const BASE = process.env.MODEL_DIAGRAM_BASE_PATH ?? "/model-diagram/";
const API_PORT = Number(process.env.MODEL_DIAGRAM_API_PORT ?? 8791);

// Strip the base prefix (default '/model-diagram') before forwarding to the
// backend, mirroring the gateway's pathRewrite so the FastAPI app keeps
// serving /api/*.
const basePrefix = BASE.replace(/\/$/, "");
const apiPrefix = basePrefix + "/api";
const stripBase = new RegExp("^" + basePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

export default defineConfig({
  base: BASE,
  plugins: [react()],
  server: {
    host: process.env.MODEL_DIAGRAM_WEB_DEV_HOST ?? "127.0.0.1",
    port: Number(process.env.MODEL_DIAGRAM_WEB_DEV_PORT ?? 5176),
    strictPort: true,
    proxy: {
      [apiPrefix]: {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
        ws: false,
        rewrite: (p) => p.replace(stripBase, ""),
        // SSE-safe: strip content-length on event-stream responses so the dev
        // proxy flushes each frame live instead of buffering to a full body
        // (the /runs/:id/events endpoint depends on this).
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            const type = proxyRes.headers["content-type"] ?? "";
            if (type.includes("text/event-stream")) {
              delete proxyRes.headers["content-length"];
            }
          });
        },
      },
    },
  },
});
