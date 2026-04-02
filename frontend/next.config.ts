import type { NextConfig } from "next";

const apiBackend = process.env.API_BACKEND_URL || "http://localhost:3001";
const nextConfig: NextConfig = {
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
