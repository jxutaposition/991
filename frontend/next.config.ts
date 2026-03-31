import type { NextConfig } from "next";

const apiBackend = process.env.API_BACKEND_URL || "http://localhost:3001";
const mockBackend = process.env.MOCK_BACKEND_URL || "http://localhost:4000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${apiBackend}/api/:path*`,
      },
      {
        source: "/mock-gtm/:path*",
        destination: `${mockBackend}/:path*`,
      },
    ];
  },
};

export default nextConfig;
