import { ObjectId } from "mongodb";
import { requireOrgById } from "@/lib/session";
import { cols } from "@/lib/db";
import { localBus, localPresence, orgChannel, realtimeDriver } from "@/lib/realtime/server";
import type { RealtimeEvent } from "@/lib/realtime/events";

export const dynamic = "force-dynamic";

/** Local-development real-time transport: Server-Sent Events fed by the in-process bus. */
export async function GET(req: Request) {
  if (realtimeDriver !== "local") return new Response("Real-time uses Pusher in this environment", { status: 404 });
  const orgId = new URL(req.url).searchParams.get("org") ?? "";
  let userId: string;
  let sessionVersion: number;
  try {
    const { user } = await requireOrgById(orgId);
    userId = user._id.toHexString();
    sessionVersion = user.sessionVersion ?? 0;
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  /** The stream outlives the request's auth check: end it once the user leaves the org or their sessions are revoked. */
  const stillAllowed = async () => {
    const c = await cols();
    const uid = new ObjectId(userId);
    const [u, m] = await Promise.all([
      c.users.findOne({ _id: uid }, { projection: { sessionVersion: 1 } }),
      c.memberships.findOne({ orgId: new ObjectId(orgId), userId: uid }, { projection: { _id: 1 } }),
    ]);
    return !!u && !!m && (u.sessionVersion ?? 0) === sessionVersion;
  };
  const channel = orgChannel(orgId);
  const bus = localBus();
  const enc = new TextEncoder();
  let cleanup = () => {};
  let done = false;
  const stream = new ReadableStream({
    start(controller) {
      // Closing makes EventSource reconnect, which re-runs the auth check above (a re-issued session passes).
      const end = () => {
        cleanup();
        try { controller.close(); } catch {}
      };
      const check = () => {
        stillAllowed().then((ok) => !ok && end(), () => {});
      };
      const send = (e: RealtimeEvent) => {
        if (done) return;
        // Membership changes come with org.changed: check before passing anything else on.
        if (e.type === "org.changed") check();
        controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      };
      const ping = setInterval(() => {
        controller.enqueue(enc.encode(`: ping\n\n`));
        check();
      }, 25_000);
      bus.on(channel, send);
      controller.enqueue(enc.encode(`retry: 2000\n: connected\n\n`));
      localPresence(orgId, userId, 1);
      cleanup = () => {
        if (done) return;
        done = true;
        clearInterval(ping);
        bus.off(channel, send);
        localPresence(orgId, userId, -1);
      };
      req.signal.addEventListener("abort", end);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
