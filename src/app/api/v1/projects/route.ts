import { botRoute } from "@/lib/bot-api";
import { cols } from "@/lib/db";
import { projectContext } from "@/lib/data";

/** GET /api/v1/projects */
export const GET = botRoute(async (_req, { org }) => {
  const c = await cols();
  const projects = await c.projects.find({ orgId: org._id }).sort({ createdAt: 1 }).toArray();
  return { projects: projects.map((p) => ({ id: p._id.toHexString(), key: p.key, name: p.name, archived: !!p.archivedAt, context: projectContext(p) })) };
});
