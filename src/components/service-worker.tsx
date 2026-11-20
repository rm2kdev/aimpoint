"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker (`public/sw.js`, VEC-156) in production builds only. The build
 * version (`AIMPOINT_BUILD_ID`, inlined from next.config.ts) goes on the script URL, so every deploy registers a new worker that replaces the old one
 * and clears its caches. In `next dev` any worker left over from a production run on the same origin
 * is removed instead, because dev chunks aren't content-hashed and a cache-first worker would serve
 * stale code under HMR.
 */
const VERSION = process.env.AIMPOINT_BUILD_ID ?? "1";

export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()));
      return;
    }
    const register = () => {
      navigator.serviceWorker
        .register(`/sw.js?v=${encodeURIComponent(VERSION)}`, { scope: "/", updateViaCache: "none" })
        .catch(() => {});
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
