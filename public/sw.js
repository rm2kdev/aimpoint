/*
 * Aimpoint service worker (VEC-156). Hand-written on purpose: it only keeps what is the same for
 * every user, so nothing personal can ever come out of a cache.
 *
 * - Precache: the offline page and the app icons.
 * - Cache-first: /_next/static/* (content-hashed build assets, safe to keep forever per build).
 * - Page navigations: always the network; if the network is unreachable, the offline page.
 *   Responses are never stored, so one user's HTML can't be shown to the next after a sign-out.
 * - Everything else (/api/*, auth, realtime/SSE, uploads, server actions, RSC fetches, POSTs,
 *   other origins like Pusher): not intercepted, so the browser goes straight to the network.
 *
 * The cache name carries the build version from the registration URL (/sw.js?v=<build>). A new
 * deploy registers a new URL, the new worker installs, takes over at once and deletes every older
 * vector-* cache on activate.
 */

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = `vector-${VERSION}`;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // The offline page must be there; icons are best-effort so a missing one can't block install.
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      await Promise.all(
        PRECACHE.slice(1).map((url) => cache.add(new Request(url, { cache: "reload" })).catch(() => {})),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("vector-") && k !== CACHE).map((k) => caches.delete(k)));
      if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // server actions, auth callbacks, uploads
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // Pusher, Vercel Blob, fonts CDN

  if (request.mode === "navigate") {
    event.respondWith(navigate(event));
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
  // Anything else (/api/*, RSC payloads, uploads, images): network only, untouched.
});

async function navigate(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch {
    const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE });
    return offline || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === "basic") cache.put(request, res.clone());
  return res;
}
