import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com", pathname: "/**" },
      { protocol: "https", hostname: "**.googleusercontent.com", pathname: "/**" },
      { protocol: "https", hostname: "secure.gravatar.com", pathname: "/**" },
      { protocol: "https", hostname: "www.gravatar.com", pathname: "/**" },
    ],
  },
};

export default nextConfig;
