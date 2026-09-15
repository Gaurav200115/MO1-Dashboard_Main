import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // kiteconnect is CommonJS and pulls in `ws`; bundling it breaks the native
  // WebSocket. mongodb resolves optional native deps at runtime and webpack
  // cannot follow those. Both stay external and are required at runtime.
  serverExternalPackages: ["kiteconnect", "mongodb"],
};

export default nextConfig;
