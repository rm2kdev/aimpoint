import "server-only";
import type { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { loadOrgDefaults } from "@/lib/org-defaults";
import { loadStatuses, requireProjectStatus } from "@/lib/statuses";
import { UserError } from "@/lib/result";
import { DEFAULT_STAGES, isDefaultStage, newTaskStatusIn, type NewTaskStatusSource, type ProjectDoc, type StatusDoc } from "@/lib/types";

/**
 * Per-project override of where new tasks land (VEC-190), the same inherit-or-override pattern as project flows:
 * `ProjectDoc.defaults.newTaskStatusId` is one of the project's own open statuses; unset = the org default
 * (`OrgDoc.defaults.newTaskStage`, lib/org-defaults.ts). Applies to tasks a PERSON creates without a status.
 * An explicit status always wins, and bots / REST / MCP creates without a status keep starting in the
 * project's first not-started status, as before the org default existed (VEC-128).
 */

const hex = (id: ObjectId) => id.toHexString();

export interface NewTaskStatus {
  status: StatusDoc | null;
  source: NewTaskStatusSource;
}

/** The status a person's new task without an explicit status starts in, for one project. */
export async function newTaskStatusFor(orgId: ObjectId, projectId: ObjectId, project?: Pick<ProjectDoc, "defaults"> | null): Promise<NewTaskStatus> {
  const c = await cols();
  const [doc, statuses, orgDefaults] = await Promise.all([
    project !== undefined ? project : c.projects.findOne({ _id: projectId, orgId }, { projection: { defaults: 1 } }),
    loadStatuses(orgId, projectId),
    loadOrgDefaults(orgId),
  ]);
  const overrideId = doc?.defaults?.newTaskStatusId ? hex(doc.defaults.newTaskStatusId) : null;
  return newTaskStatusIn(statuses, overrideId, orgDefaults.newTaskStage, (s) => hex(s._id));
}

/**
 * Sets (a status id of this project) or clears (null / "") the project's override. The status must be one of the
 * project's own (another project's id is refused, VEC-115) and in an open stage new tasks may start in.
 * Authorisation (admin) is the caller's job.
 */
export async function setProjectNewTaskStatus(orgId: ObjectId, projectId: ObjectId, statusId: string | null): Promise<StatusDoc | null> {
  const c = await cols();
  if (!statusId) {
    await c.projects.updateOne({ _id: projectId, orgId }, { $unset: { "defaults.newTaskStatusId": "" } });
    return null;
  }
  const status = await requireProjectStatus(orgId, projectId, statusId);
  if (!isDefaultStage(status.category)) {
    throw new UserError(`New tasks can't start in ${status.name}: pick a status in one of the stages ${DEFAULT_STAGES.join(", ")}.`);
  }
  await c.projects.updateOne({ _id: projectId, orgId }, { $set: { "defaults.newTaskStatusId": status._id } });
  return status;
}

/**
 * Drops the override on every project that points at one of `statusIds` (the status was deleted or moved out of
 * the open stages), so no project keeps a dangling id and new tasks fall back to the org default. Returns the count.
 */
export async function clearNewTaskStatusOverrides(orgId: ObjectId, statusIds: ObjectId[]): Promise<number> {
  if (!statusIds.length) return 0;
  const r = await (await cols()).projects.updateMany(
    { orgId, "defaults.newTaskStatusId": { $in: statusIds } },
    { $unset: { "defaults.newTaskStatusId": "" } },
  );
  return r.modifiedCount;
}

/** Agent-facing shape (MCP get_workspace / task context, REST /projects): where a person's new task lands here. */
export interface BotNewTaskView {
  status: string | null;
  statusId: string | null;
  stage: string | null;
  /** "project" = this project's own override, "org" = the org default stage, "fallback" = first not-started status. */
  source: NewTaskStatusSource;
}

export const NEW_TASKS_NOTE =
  "Where a task a person creates without a status starts. An explicit status always wins; tasks bots create without a status start in the project's first not-started status.";

/** Builds the agent view for each project in one pass (statuses already grouped by project, in order). */
export async function botNewTaskViews(orgId: ObjectId, projects: Pick<ProjectDoc, "_id" | "defaults">[], byProject: Map<string, StatusDoc[]>) {
  const { newTaskStage } = await loadOrgDefaults(orgId);
  const out = new Map<string, BotNewTaskView>();
  for (const p of projects) {
    const overrideId = p.defaults?.newTaskStatusId ? hex(p.defaults.newTaskStatusId) : null;
    const { status, source } = newTaskStatusIn(byProject.get(hex(p._id)) ?? [], overrideId, newTaskStage, (s) => hex(s._id));
    out.set(hex(p._id), {
      status: status?.name ?? null,
      statusId: status ? hex(status._id) : null,
      stage: status?.category ?? null,
      source,
    });
  }
  return out;
}
