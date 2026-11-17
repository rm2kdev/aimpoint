import { botRoute } from "@/lib/bot-api";
import { cols } from "@/lib/db";
import { projectContext } from "@/lib/data";
import { groupStatusesByProject } from "@/lib/statuses";
import { botOrgFlows } from "@/lib/flow-bot-view";

/**
 * GET /api/v1/projects  Each project with its context, its own statuses in workflow order (statuses are per project)
 * and its resolved `flow` (VEC-176, same shape as get_workspace: steps with owner, status, instructions; null = off).
 */
export const GET = botRoute(async (_req, { org }) => {
  const c = await cols();
  const [projects, statuses, flows] = await Promise.all([
    c.projects.find({ orgId: org._id }).sort({ createdAt: 1 }).toArray(),
    c.statuses.find({ orgId: org._id }).sort({ order: 1 }).toArray(),
    botOrgFlows(org._id),
  ]);
  const byProject = groupStatusesByProject(statuses);
  return {
    projects: projects.map((p) => ({
      id: p._id.toHexString(),
      key: p.key,
      name: p.name,
      archived: !!p.archivedAt,
      context: projectContext(p),
      statuses: (byProject.get(p._id.toHexString()) ?? []).map((s) => ({ id: s._id.toHexString(), name: s.name, stage: s.category })),
      flow: flows.get(p._id.toHexString()) ?? null,
    })),
  };
});
