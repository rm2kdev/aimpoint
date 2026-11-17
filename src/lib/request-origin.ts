import "server-only";
import { headers } from "next/headers";

/** Origin for Stripe's return URLs: the browser's Origin header (server actions always send it), else the host. */
export async function requestOrigin(): Promise<string> {
  const h = await headers();
  const origin = h.get("origin");
  if (origin) return origin;
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) throw new Error("Can't tell this site's address for the Stripe return URL.");
  return `${h.get("x-forwarded-proto") ?? "http"}://${host}`;
}
