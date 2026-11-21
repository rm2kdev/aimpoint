import { botRoute } from "@/lib/bot-api";
import { loadShell } from "@/lib/data";
import { cols } from "@/lib/db";
import { DISABLED_BOT_FILTER } from "@/lib/bot-enabled";

/** GET /api/v1/members: people and bots that tasks can be assigned to. Disabled bots (VEC-344) are left out. */
export const GET = botRoute(async (_req, { org, bot }) => {
  const [{ members }, disabled] = await Promise.all([
    loadShell(org._id, bot._id),
    (await cols()).bots.find({ orgId: org._id, ...DISABLED_BOT_FILTER }, { projection: { _id: 1 } }).toArray(),
  ]);
  const off = new Set(disabled.map((b) => b._id.toHexString()));
  return { members: members.filter((m) => m.kind !== "bot" || !off.has(m.id)).map((m) => ({ id: m.id, name: m.name, kind: m.kind, email: m.kind === "user" ? m.email : undefined })) };
});
