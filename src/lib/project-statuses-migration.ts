// No "server-only" and no path aliases: scripts/migrate-project-statuses.ts runs this file with plain node
// (type stripping) against the live database, because the dev server caches its init on globalThis.
import { ObjectId, type Db } from "mongodb";
import type { ActivityDoc, ProjectDoc, StatusDoc, TaskDoc } from "./types";

export const PROJECT_STATUSES_MIGRATION = "2026-11-project-statuses";

type Report = { orgs: number; projects: number; statusesCreated: number; tasksRemapped: number; activityRemapped: number; orgStatusesRemoved: number };

/**
 * VEC-114: statuses move from the organisation to each project. For every project, copy the org's statuses
 * (those without a projectId) into project-scoped docs, point the project's tasks and their status-change
 * activity at the copies, then delete the org-level docs. Safe to re-run: a project that already has its
 * statuses keeps them (old ids map to them by name and stage), and an org with no org-level statuses left is skipped.
 */
export async function migrateProjectStatuses(db: Db): Promise<Report> {
  const statuses = db.collection<StatusDoc>("statuses");
  const tasks = db.collection<TaskDoc>("tasks");
  const activity = db.collection<ActivityDoc>("activity");
  const projects = db.collection<ProjectDoc>("projects");
  const report: Report = { orgs: 0, projects: 0, statusesCreated: 0, tasksRemapped: 0, activityRemapped: 0, orgStatusesRemoved: 0 };
  const legacy = { projectId: { $exists: false } } as const;

  for (const orgId of await statuses.distinct("orgId", legacy)) {
    const orgStatuses = await statuses.find({ orgId, ...legacy }).sort({ order: 1 }).toArray();
    if (!orgStatuses.length) continue;
    report.orgs++;
    for (const project of await projects.find({ orgId }).toArray()) {
      let own = await statuses.find({ orgId, projectId: project._id }).toArray();
      if (!own.length) {
        own = orgStatuses.map((s) => ({ _id: new ObjectId(), orgId, projectId: project._id, name: s.name, color: s.color, category: s.category, order: s.order }));
        await statuses.insertMany(own);
        report.statusesCreated += own.length;
      }
      report.projects++;
      const taskIds = (await tasks.find({ orgId, projectId: project._id }, { projection: { _id: 1 } }).toArray()).map((t) => t._id);
      for (const old of orgStatuses) {
        const copy = own.find((s) => s.category === old.category && s.name === old.name) ?? own.find((s) => s.category === old.category);
        if (!copy) throw new Error(`[migrate] project ${project.key} has no status for stage ${old.category}`);
        // updatedAt stays as it was: this is bookkeeping, not an edit anyone made.
        const r = await tasks.updateMany({ orgId, projectId: project._id, statusId: old._id }, { $set: { statusId: copy._id } });
        report.tasksRemapped += r.modifiedCount;
        if (!taskIds.length) continue;
        const [from, to] = await Promise.all([
          activity.updateMany({ taskId: { $in: taskIds }, kind: "status", from: old._id.toHexString() }, { $set: { from: copy._id.toHexString() } }),
          activity.updateMany({ taskId: { $in: taskIds }, kind: "status", to: old._id.toHexString() }, { $set: { to: copy._id.toHexString() } }),
        ]);
        report.activityRemapped += from.modifiedCount + to.modifiedCount;
      }
    }
    // Only delete once nothing points at the org-level docs any more (a task in a missing project would).
    const oldIds = orgStatuses.map((s) => s._id);
    const left = await tasks.countDocuments({ orgId, statusId: { $in: oldIds } });
    if (left) throw new Error(`[migrate] ${left} task(s) in org ${orgId.toHexString()} still use org-level statuses (project missing?)`);
    report.orgStatusesRemoved += (await statuses.deleteMany({ orgId, _id: { $in: oldIds } })).deletedCount;
  }
  return report;
}
