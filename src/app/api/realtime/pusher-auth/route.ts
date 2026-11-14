import { requireOrgById } from "@/lib/session";
import { pusher, realtimeDriver } from "@/lib/realtime/server";

/** Authorises Pusher private channels: private-org-<orgId> requires membership. */
export async function POST(req: Request) {
  if (realtimeDriver !== "pusher") return new Response("Not configured", { status: 404 });
  const form = await req.formData();
  const socketId = String(form.get("socket_id") ?? "");
  const channel = String(form.get("channel_name") ?? "");
  const m = /^private-org-([a-f0-9]{24})$/.exec(channel);
  if (!m || !socketId) return new Response("Bad request", { status: 400 });
  try {
    await requireOrgById(m[1]);
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  return Response.json(pusher().authorizeChannel(socketId, channel));
}
