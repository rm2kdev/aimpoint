import { requireOrgById } from "@/lib/session";
import { pusher, realtimeDriver } from "@/lib/realtime/server";

/** Authorises Pusher private-org-<id> and presence-org-<id> channels; both require membership. */
export async function POST(req: Request) {
  if (realtimeDriver !== "pusher") return new Response("Not configured", { status: 404 });
  const form = await req.formData();
  const socketId = String(form.get("socket_id") ?? "");
  const channel = String(form.get("channel_name") ?? "");
  const m = /^(private|presence)-org-([a-f0-9]{24})$/.exec(channel);
  if (!m || !socketId) return new Response("Bad request", { status: 400 });
  let user;
  try {
    user = (await requireOrgById(m[2])).user;
  } catch {
    return new Response("Forbidden", { status: 403 });
  }
  if (m[1] === "presence") {
    return Response.json(
      pusher().authorizeChannel(socketId, channel, { user_id: user._id.toHexString(), user_info: { name: user.name } }),
    );
  }
  return Response.json(pusher().authorizeChannel(socketId, channel));
}
