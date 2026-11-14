import { requireOrgById } from "@/lib/session";
import { localBus, localPresence, orgChannel, realtimeDriver } from "@/lib/realtime/server";
import type { RealtimeEvent } from "@/lib/realtime/events";

export const dynamic = "force-dynamic";

/** Local-development real-time transport: Server-Sent Events fed by the in-process bus. */
export async function GET(req: Request) {
  if (realtimeDriver !== "local") return new Response("Real-time uses Pusher in this environment", { status: 404 });
  const orgId = new URL(req.url).searchParams.get("org") ?? "";
  let userId: string;
  try {
    userId = (await requireOrgById(orgId)).user._id.toHexString();
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  const channel = orgChannel(orgId);
  const bus = localBus();
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: RealtimeEvent) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => controller.enqueue(enc.encode(`: ping\n\n`)), 25_000);
      bus.on(channel, send);
      controller.enqueue(enc.encode(`retry: 2000\n: connected\n\n`));
      localPresence(orgId, userId, 1);
      let done = false;
      cleanup = () => {
        if (done) return;
        done = true;
        clearInterval(ping);
        bus.off(channel, send);
        localPresence(orgId, userId, -1);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try { controller.close(); } catch {}
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
