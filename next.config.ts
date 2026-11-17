import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every screen is per-user and per-organisation, so routes render at request time.
  cacheComponents: false,
  devIndicators: { position: "bottom-right" },
  // Build version for the service worker URL (VEC-156): each deploy registers /sw.js?v=<new id>,
  // which installs a fresh worker and drops the previous build's caches.
  env: { VECTOR_BUILD_ID: process.env.VERCEL_GIT_COMMIT_SHA || Date.now().toString(36) },
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
  async headers() {
    return [
      {
        // The worker must always be re-checked (never served from the HTTP cache) and may control
        // the whole origin (VEC-156).
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
      {
        source: "/offline.html",
        headers: [{ key: "Cache-Control", value: "no-cache" }],
      },
      {
        // External forms (VEC-207): the public form page may be embedded in an iframe on any site. Only this
        // route relaxes frame-ancestors; it is also kept out of search results.
        source: "/f/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors *" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        // Org pages moved from /:org/... to /o/:org/... . Keep old bookmarks and shared
        // links working (query strings like ?task=VEC-8 are passed through by Next).
        // Skips the real top-level routes, Next internals (_next, __nextjs_*), dotfiles
        // like .well-known, and static files (anything with a dot, e.g. favicon.ico).
        source: "/:org((?!(?:o|p|f|api|login|signup|onboarding|invite|actions|account)(?:/|$))[^./_][^./]*)/:path*",
        destination: "/o/:org/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
