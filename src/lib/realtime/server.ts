import "server-only";
import { EventEmitter } from "node:events";
import Pusher from "pusher";
import { ObjectId } from "mongodb";
import { loadBotWorkload, withWorkingBots } from "@/lib/data";
import { billingOn } from "@/lib/billing";
import { orgActiveById } from "@/lib/billing-limits";
import type { RealtimeEvent } from "./events";

/**
 * Server-side publisher. Driver:
 *  - "pusher" when PUSHER_APP_ID etc. are set (Vercel / production)
 *  - "local" otherwise: an in-process emitter consumed by the SSE route.
 */
export const realtimeDriver: "pusher" | "local" =
  process.env.PUSHER_APP_ID && process.env.PUSHER_SECRET && process.env.NEXT_PUBLIC_PUSHER_KEY ? "pusher" : "local";

const g = globalThis as unknown as { __aimpointBus?: EventEmitter; __aimpointPusher?: Pusher };

export function localBus(): EventEmitter {
  if (!g.__aimpointBus) {
    g.__aimpointBus = new EventEmitter();
    g.__aimpointBus.setMaxListeners(0);
  }
  return g.__aimpointBus;
}

export function pusher(): Pusher {
  g.__aimpointPusher ??= new Pusher({
    appId: process.env.PUSHER_APP_ID!,
    key: process.env.NEXT_PUBLIC_PUSHER_KEY!,
    secret: process.env.PUSHER_SECRET!,
    cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER ?? "mt1",
    useTLS: true,
  });
  return g.__aimpointPusher;
}

export const orgChannel = (orgId: string) => `private-org-${orgId}`;
export const presenceChannel = (orgId: string) => `presence-org-${orgId}`;

/** Local-driver presence: open SSE connections per org and user. */
const p = globalThis as unknown as { __aimpointPresence?: Map<string, Map<string, number>> };
export function localPresence(orgId: string, userId: string, delta: 1 | -1) {
  p.__aimpointPresence ??= new Map();
  const org = p.__aimpointPresence.get(orgId) ?? new Map<string, number>();
  const n = (org.get(userId) ?? 0) + delta;
  if (n > 0) org.set(userId, n);
  else org.delete(userId);
  p.__aimpointPresence.set(orgId, org);
  localBus().emit(orgChannel(orgId), { type: "presence", userIds: [...org.keys()] });
}

/**
 * A task.upsert always carries the task's current `workingBotIds` (looked up here, so callers can't send a
 * stale or empty list). The task object is updated in place, so a caller returning it gets the same list.
 */
export async function publish(orgId: string, event: RealtimeEvent, opts: { workingLoaded?: boolean } = {}) {
  const live = await liveOrg(orgId, event);
  try {
    if (live) {
      if (event.type === "task.upsert" && !opts.workingLoaded) await withWorkingBots([event.task]);
      await emit(orgId, event);
    }
  } catch (err) {
    // Real-time is best-effort; the write already succeeded.
    console.error("[realtime] publish failed", err);
  }
  // Every change that can move a task in or out of "unassigned" Stalled ends in its task.upsert (VEC-108).
  if (event.type === "task.upsert") await (await import("@/lib/stalled-notice")).syncStalledNotice(orgId, event.task);
  if (live && WORKLOAD_TRIGGERS.has(event.type)) await refreshWorkload(orgId);
}

/**
 * VEC-263: a locked org (hosted, no live subscription) gets no realtime events, since Pusher messages are the cost
 * driver. `org.changed` still goes out, so a tab that was open when the org locked (or unlocked) refreshes into the
 * right state. Billing off (self-hosted) is always live. A failed lookup publishes as before.
 */
async function liveOrg(orgId: string, event: RealtimeEvent): Promise<boolean> {
  if (event.type === "org.changed") return true;
  try {
    if (!(await billingOn())) return true;
    return await orgActiveById(new ObjectId(orgId));
  } catch {
    return true;
  }
}

async function emit(orgId: string, event: RealtimeEvent) {
  if (realtimeDriver === "pusher") await pusher().trigger(orgChannel(orgId), "event", event);
  else localBus().emit(orgChannel(orgId), event);
}

/*
 * Live per-bot workload (the bot status tray).
 *
 * Why here and not at each claim mutation site: every `agentClaims` change already ends in one of these
 * events (pickup/complete/release go through publishWorking -> task.upsert; closing or archiving a task is
 * a task.upsert; task/project delete send task.delete; bot delete and status-stage edits send org.changed).
 * Recomputing the snapshot from the database after those events means a new claim site can't forget to
 * update the tray, and the client never has to know every task in the org to count claims itself.
 *
 * Recomputes per org are coalesced: while one is running, further triggers just mark it dirty and it runs
 * once more, so a burst (e.g. deleting a project with 200 tasks) costs two queries, not 200. A snapshot
 * is only sent when it differs from the last one this process sent, and carries `at` (taken before the
 * query) so clients keep the newest of the server-rendered value and live events.
 */
const WORKLOAD_TRIGGERS = new Set<RealtimeEvent["type"]>(["task.upsert", "task.delete", "org.changed"]);
type WorkloadState = { running: Promise<void> | null; dirty: boolean; last: string };
const w = globalThis as unknown as { __aimpointWorkload?: Map<string, WorkloadState> };

export function refreshWorkload(orgId: string): Promise<void> {
  w.__aimpointWorkload ??= new Map();
  let s = w.__aimpointWorkload.get(orgId);
  if (!s) w.__aimpointWorkload.set(orgId, (s = { running: null, dirty: false, last: "" }));
  const state = s;
  if (state.running) {
    state.dirty = true;
    return state.running;
  }
  state.running = (async () => {
    try {
      do {
        state.dirty = false;
        const at = Date.now();
        const bots = await loadBotWorkload(new ObjectId(orgId));
        const sig = JSON.stringify(bots);
        // Skip unchanged snapshots. Only safe in one process: with Pusher, another instance may have sent a
        // newer, different snapshot since this one's `last`.
        if (realtimeDriver === "local" && sig === state.last) continue;
        state.last = sig;
        await emit(orgId, { type: "bots.workload", at, bots });
      } while (state.dirty);
    } catch (err) {
      state.last = ""; // resend next time
      console.error("[realtime] workload publish failed", err);
    } finally {
      state.running = null;
    }
  })();
  return state.running;
}
