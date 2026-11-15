import "server-only";
import { EventEmitter } from "node:events";
import Pusher from "pusher";
import { withWorkingBots } from "@/lib/data";
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
export const presenceChannel = (orgId: string) => `presence-org-${orgId}`;

/** Local-driver presence: open SSE connections per org and user. */
const p = globalThis as unknown as { __vectorPresence?: Map<string, Map<string, number>> };
export function localPresence(orgId: string, userId: string, delta: 1 | -1) {
  p.__vectorPresence ??= new Map();
  const org = p.__vectorPresence.get(orgId) ?? new Map<string, number>();
  const n = (org.get(userId) ?? 0) + delta;
  if (n > 0) org.set(userId, n);
  else org.delete(userId);
  p.__vectorPresence.set(orgId, org);
  localBus().emit(orgChannel(orgId), { type: "presence", userIds: [...org.keys()] });
}

/**
 * A task.upsert always carries the task's current `workingBotIds` (looked up here, so callers can't send a
 * stale or empty list). The task object is updated in place, so a caller returning it gets the same list.
 */
export async function publish(orgId: string, event: RealtimeEvent, opts: { workingLoaded?: boolean } = {}) {
  try {
    if (event.type === "task.upsert" && !opts.workingLoaded) await withWorkingBots([event.task]);
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
