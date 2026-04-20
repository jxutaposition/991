import type { NextConfig } from "next";

const apiBackend = process.env.API_BACKEND_URL || "http://localhost:3001";
const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com", pathname: "/**" },
      { protocol: "https", hostname: "**.googleusercontent.com", pathname: "/**" },
      { protocol: "https", hostname: "secure.gravatar.com", pathname: "/**" },
      { protocol: "https", hostname: "www.gravatar.com", pathname: "/**" },
    ],
  },
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
