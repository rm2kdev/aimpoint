import type { MetadataRoute } from "next";

// Web app manifest (VEC-153), served at /manifest.webmanifest. Icons are rendered from icon.svg by scripts/pwa-icons.mjs.
// Colours match the light theme's --background (globals.css); the viewport export in layout.tsx carries the dark variant.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Aimpoint",
    short_name: "Aimpoint",
    description: "Issues and feature requests for small software teams.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
