import type { NextConfig } from "next";

const apiBackend = process.env.API_BACKEND_URL || "http://localhost:3001";
const nextConfig: NextConfig = {
  experimental: {
    // Increase proxy timeout for slow LLM calls (Opus planning can take 60s+)
    proxyTimeout: 300_000,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiBackend}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
