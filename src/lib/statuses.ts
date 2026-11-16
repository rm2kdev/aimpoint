import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { DEFAULT_STATUSES, toStatus } from "@/lib/data";
import { UserError } from "@/lib/result";
import { matchStatus, missingStages, pickStatus, type Status, type StatusCategory, type StatusDoc } from "@/lib/types";

/**
 * Per-project statuses (VEC-114). Every project owns its ordered status list; stages (StatusCategory) are
 * fixed and drive all logic. Every task's statusId points at a status of the task's own project, so resolve
 * statuses through these helpers rather than querying `{orgId}` alone, which returns every project's copies.
 */

const hex = (id: ObjectId) => id.toHexString();

/** A project's statuses in workflow order. */
export async function loadStatuses(orgId: ObjectId, projectId: ObjectId): Promise<StatusDoc[]> {
  const c = await cols();
  return c.statuses.find({ orgId, projectId }).sort({ order: 1 }).toArray();
}

/** Every project's statuses in one query: project id (hex) -> its statuses in workflow order. */
export async function loadStatusMap(orgId: ObjectId): Promise<Map<string, StatusDoc[]>> {
  const c = await cols();
  return groupStatusesByProject(await c.statuses.find({ orgId }).sort({ order: 1 }).toArray());
}

/** Groups status docs (already in order) by project id. */
export function groupStatusesByProject(list: StatusDoc[]): Map<string, StatusDoc[]> {
  const map = new Map<string, StatusDoc[]>();
  for (const s of list) {
    const key = hex(s.projectId);
    const bucket = map.get(key);
    if (bucket) bucket.push(s);
    else map.set(key, [s]);
  }
  return map;
}

/** Same as loadStatusMap, as client `Status` objects. */
export async function loadStatusMapForClient(orgId: ObjectId): Promise<Record<string, Status[]>> {
  const out: Record<string, Status[]> = {};
  for (const [pid, list] of await loadStatusMap(orgId)) out[pid] = list.map(toStatus);
  return out;
}

/**
 * Resolves `ref` within the project's own statuses: a status id, a name (case-insensitive) or a stage
 * (first status of that stage in workflow order). An id of ANOTHER project's status maps to this project's
 * corresponding status (same name and stage, else same stage), so a stale picker id never crosses projects.
 */
export async function statusFor(orgId: ObjectId, projectId: ObjectId, ref: string | StatusCategory): Promise<StatusDoc | null> {
  const list = await loadStatuses(orgId, projectId);
  const hit = pickStatus(list, ref, (s) => hex(s._id));
  if (hit || !ObjectId.isValid(ref)) return hit;
  const c = await cols();
  const other = await c.statuses.findOne({ _id: new ObjectId(ref), orgId });
  return other ? matchStatus(list, other) : null;
}

/** The project's status that corresponds to `statusId` (from any project of the org): used when a task changes project. */
export async function statusInProject(orgId: ObjectId, projectId: ObjectId, statusId: ObjectId): Promise<StatusDoc | null> {
  return statusFor(orgId, projectId, hex(statusId));
}

/** Gives a new project the default status set. Returns the inserted statuses. */
export async function seedProjectStatuses(orgId: ObjectId, projectId: ObjectId): Promise<StatusDoc[]> {
  const c = await cols();
  const docs: StatusDoc[] = DEFAULT_STATUSES.map((s) => ({ ...s, _id: new ObjectId(), orgId, projectId }));
  await c.statuses.insertMany(docs);
  return docs;
}

/** Removes a deleted project's statuses. */
export async function deleteProjectStatuses(orgId: ObjectId, projectId: ObjectId): Promise<number> {
  const c = await cols();
  return (await c.statuses.deleteMany({ orgId, projectId })).deletedCount;
}

/**
 * The guard rule: a project keeps at least one status in each of backlog, triage, unstarted, done and
 * cancelled, so triage, bot hand-offs and close-outs always resolve. Throws a UserError naming what's missing
 * when `next` (the project's statuses after a proposed change) breaks it.
 */
export function assertRequiredStages(next: readonly { category: StatusCategory }[], projectName?: string) {
  const missing = missingStages(next);
  if (!missing.length) return;
  const where = projectName ? `${projectName} needs` : "A project needs";
  throw new UserError(`${where} at least one status in each of backlog, triage, not started, done and cancelled. This change would leave none in: ${missing.join(", ")}.`);
}
