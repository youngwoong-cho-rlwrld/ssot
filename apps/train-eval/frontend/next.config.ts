import type { NextConfig } from "next";

// Base path the gateway mounts this app under. Next auto-prefixes rewrite
// sources, next/link hrefs, and static assets with it; client-side fetches
// are prefixed manually via NEXT_PUBLIC_BASE_PATH (see src/lib/api.ts).
const basePath = process.env.TRAIN_EVAL_BASE_PATH ?? "/train-eval";

const nextConfig: NextConfig = {
  basePath,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${process.env.BACKEND_INTERNAL_ORIGIN ?? "http://127.0.0.1:8000"}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
