import type { NextConfig } from "next";

const basePath = process.env.RESULTS_BASE_PATH ?? "/results";

const allowedDevOrigins = (process.env.RESULTS_ALLOWED_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@ssot/ui"],
  basePath,
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  ...(allowedDevOrigins.length ? { allowedDevOrigins } : {}),
};

export default nextConfig;
