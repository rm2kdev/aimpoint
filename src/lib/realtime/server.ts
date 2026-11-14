import "server-only";
import { EventEmitter } from "node:events";
import Pusher from "pusher";
import type { RealtimeEvent } from "./events";

/**
 * Server-side publisher. Driver:
 *  - "pusher" when PUSHER_APP_ID etc. are set (Vercel / production)
 *  - "local" otherwise: an in-process emitter consumed by the SSE route.
 */
export const realtimeDriver: "pusher" | "local" =
  process.env.PUSHER_APP_ID && process.env.PUSHER_SECRET && process.env.NEXT_PUBLIC_PUSHER_KEY ? "pusher" : "local";

const g = globalThis as unknown as { __vectorBus?: EventEmitter; __vectorPusher?: Pusher };

export function localBus(): EventEmitter {
  if (!g.__vectorBus) {
    g.__vectorBus = new EventEmitter();
    g.__vectorBus.setMaxListeners(0);
  }
  return g.__vectorBus;
}

export function pusher(): Pusher {
  g.__vectorPusher ??= new Pusher({
    appId: process.env.PUSHER_APP_ID!,
    key: process.env.NEXT_PUBLIC_PUSHER_KEY!,
    secret: process.env.PUSHER_SECRET!,
    cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER ?? "mt1",
    useTLS: true,
  });
  return g.__vectorPusher;
}

export const orgChannel = (orgId: string) => `private-org-${orgId}`;

export async function publish(orgId: string, event: RealtimeEvent) {
  try {
    if (realtimeDriver === "pusher") {
      await pusher().trigger(orgChannel(orgId), "event", event);
    } else {
      localBus().emit(orgChannel(orgId), event);
    }
  } catch (err) {
    // Real-time is best-effort; the write already succeeded.
    console.error("[realtime] publish failed", err);
  }
}
