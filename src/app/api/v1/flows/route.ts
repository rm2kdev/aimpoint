import { botRoute } from "@/lib/bot-api";
import { cols } from "@/lib/db";
import { botOrgFlows } from "@/lib/flow-bot-view";

/**
 * GET /api/v1/flows  Each project's resolved flow (VEC-176): who handles a task at each step, in order, with the
 * step's status, owner, instructions and how it moves on (`advance`: complete / wait / manual). `flow` null = the
 * project switched flows off; `active` false = no step names an owner or instructions (the seeded default). Same
 * objects as `flow` per project in get_workspace and GET /api/v1/projects. Flows are edited by admins in the app.
 */
export const GET = botRoute(async (_req, { org }) => {
  const c = await cols();
  const [projects, flows] = await Promise.all([
    c.projects.find({ orgId: org._id }, { projection: { key: 1, name: 1, archivedAt: 1, flowMode: 1 } }).sort({ createdAt: 1 }).toArray(),
    botOrgFlows(org._id),
  ]);
  return {
    projects: projects.map((p) => ({
      id: p._id.toHexString(),
      key: p.key,
      name: p.name,
      archived: !!p.archivedAt,
      /** inherit = follows the org default, custom = its own flow, off = no flow. */
      flowMode: p.flowMode ?? "inherit",
      flow: flows.get(p._id.toHexString()) ?? null,
    })),
  };
}, "get_workspace");
