import { botRoute, resolveProject } from "@/lib/bot-api";
import { cols } from "@/lib/db";
import { groupStatusesByProject, loadStatuses } from "@/lib/statuses";
import type { StatusDoc } from "@/lib/types";

const out = (s: StatusDoc) => ({ id: s._id.toHexString(), name: s.name, stage: s.category });

/**
 * GET /api/v1/statuses?project=WEB  One project's workflow, in order: { project: {id, key, name}, statuses: [{id, name, stage}] }.
 * GET /api/v1/statuses              Every project's, grouped: { projects: [{id, key, name, statuses}] }.
 * Statuses are per project (VEC-114): a task only takes its own project's statuses. `stage` (backlog, triage,
 * unstarted, started, done, cancelled) is what Vector acts on whatever the status is called. An unknown or
 * empty `project` is a 400.
 */
export const GET = botRoute(async (req, { org }) => {
  const q = new URL(req.url).searchParams;
  if (q.has("project")) {
    const p = await resolveProject(org._id, q.get("project"));
    return { project: { id: p._id.toHexString(), key: p.key, name: p.name }, statuses: (await loadStatuses(org._id, p._id)).map(out) };
  }
  const c = await cols();
  const [projects, statuses] = await Promise.all([
    c.projects.find({ orgId: org._id }).sort({ createdAt: 1 }).toArray(),
    c.statuses.find({ orgId: org._id }).sort({ order: 1 }).toArray(),
  ]);
  const byProject = groupStatusesByProject(statuses);
  return { projects: projects.map((p) => ({ id: p._id.toHexString(), key: p.key, name: p.name, statuses: (byProject.get(p._id.toHexString()) ?? []).map(out) })) };
});
