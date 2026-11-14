import { botRoute } from "@/lib/bot-api";
import { cols } from "@/lib/db";

/** GET /api/v1/statuses: the organisation's workflow, in order. */
export const GET = botRoute(async (_req, { org }) => {
  const c = await cols();
  const statuses = await c.statuses.find({ orgId: org._id }).sort({ order: 1 }).toArray();
  return { statuses: statuses.map((s) => ({ id: s._id.toHexString(), name: s.name, stage: s.category })) };
});
