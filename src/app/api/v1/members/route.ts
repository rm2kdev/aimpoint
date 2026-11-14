import { botRoute } from "@/lib/bot-api";
import { loadShell } from "@/lib/data";

/** GET /api/v1/members: people and bots that tasks can be assigned to. */
export const GET = botRoute(async (_req, { org, bot }) => {
  const { members } = await loadShell(org._id, bot._id);
  return { members: members.map((m) => ({ id: m.id, name: m.name, kind: m.kind, email: m.kind === "user" ? m.email : undefined })) };
});
