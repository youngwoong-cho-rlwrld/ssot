import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.URDF_DEV_HOST ?? "127.0.0.1";
const port = Number(process.env.URDF_DEV_PORT ?? 5173);

export default defineConfig({
  base: process.env.URDF_BASE_PATH ?? "/urdf/",
  plugins: [react()],
  server: { host, port, strictPort: true },
  preview: { host, port, strictPort: true },
});
