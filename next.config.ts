import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every screen is per-user and per-organisation, so routes render at request time.
  cacheComponents: false,
  devIndicators: { position: "bottom-right" },
  // Let other machines on the LAN (e.g. the Mac mini at 10.0.0.2) load dev JS/HMR.
  allowedDevOrigins: ["10.0.0.2", "192.168.1.90", "*.local"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "*.public.blob.vercel-storage.com" }],
  },
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
};

export default nextConfig;
