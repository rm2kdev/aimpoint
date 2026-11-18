import "server-only";
import { requestOrigin } from "@/lib/request-origin";

/**
 * Base URL for absolute links that leave the app (emails). `AUTH_URL` (the Auth.js canonical URL) wins when set,
 * so links always name the public host; otherwise the request's own origin (`requestOrigin`), which is the
 * address the admin is using (app.aimpoint.dev / dev.aimpoint.dev on Vercel, localhost or the LAN IP in dev).
 */
export async function appBaseUrl(): Promise<string> {
  const configured = process.env.AUTH_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      console.warn("[app-url] AUTH_URL isn't a valid URL; using the request origin for links.");
    }
  }
  return requestOrigin();
}
