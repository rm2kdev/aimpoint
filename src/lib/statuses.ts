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

/** "Todo, In Progress, Done" for error messages. */
const names = (list: StatusDoc[]) => list.map((s) => s.name).join(", ");

/** The project key for messages ("VEC"). */
async function projectLabel(orgId: ObjectId, projectId: ObjectId) {
  const p = await (await cols()).projects.findOne({ _id: projectId, orgId }, { projection: { key: 1, name: 1 } });
  return p ? p.key : "this project";
}

/**
 * A status id that must belong to `projectId` (VEC-115): tasks only ever point at a status of their own project.
 * An id of another project's status is refused with a UserError naming both projects, never silently mapped.
 */
export async function requireProjectStatus(orgId: ObjectId, projectId: ObjectId, statusId: string): Promise<StatusDoc> {
  const list = await loadStatuses(orgId, projectId);
  const hit = ObjectId.isValid(statusId) ? list.find((s) => hex(s._id) === statusId) : undefined;
  if (hit) return hit;
  const c = await cols();
  const other = ObjectId.isValid(statusId) ? await c.statuses.findOne({ _id: new ObjectId(statusId), orgId }) : null;
  const here = await projectLabel(orgId, projectId);
  if (other) {
    const there = await projectLabel(orgId, other.projectId);
    throw new UserError(`"${other.name}" is a status of ${there}, not ${here}. Pick one of ${here}'s statuses: ${names(list)}.`);
  }
  throw new UserError(`Unknown status. ${here}'s statuses are: ${names(list)}.`);
}

/**
 * A status reference typed by a bot or API caller (name, stage or id), resolved within ONE project. Names and
 * stages resolve to that project's own status; an id must already be one of its statuses (see requireProjectStatus).
 */
export async function resolveProjectStatus(orgId: ObjectId, projectId: ObjectId, ref: string): Promise<StatusDoc> {
  const r = ref.trim();
  if (ObjectId.isValid(r) && r.length === 24) return requireProjectStatus(orgId, projectId, r.toLowerCase());
  const list = await loadStatuses(orgId, projectId);
  const hit = pickStatus(list, r);
  if (hit) return hit;
  const here = await projectLabel(orgId, projectId);
  // A name another project uses (VEC-116): say so, so the caller doesn't think the name is mistyped.
  const c = await cols();
  const elsewhere = r ? await c.statuses.find({ orgId, projectId: { $ne: projectId }, name: { $regex: `^${escapeRegex(r)}$`, $options: "i" } }, { projection: { projectId: 1, name: 1 } }).toArray() : [];
  if (elsewhere.length) {
    const keys = [...new Set(await Promise.all(elsewhere.map((s) => projectLabel(orgId, s.projectId))))].sort();
    throw new UserError(`"${elsewhere[0].name}" is a status of ${keys.join(", ")}, not ${here}. Statuses are per project; ${here}'s statuses are: ${names(list)}.`);
  }
  throw new UserError(`Unknown status "${r}". ${here}'s statuses are: ${names(list)}.`);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Status ids matching a list filter (VEC-116). With `projectId`, the one status of that project (resolved like a
 * write). Without, every project's status with that name (or that id), so "Done" finds done tasks in every project
 * that has a status called Done. Throws a UserError listing the known names when nothing matches.
 */
export async function statusFilterIds(orgId: ObjectId, ref: string, projectId?: ObjectId): Promise<ObjectId[]> {
  if (projectId) return [(await resolveProjectStatus(orgId, projectId, ref))._id];
  const r = ref.trim();
  const all = await (await cols()).statuses.find({ orgId }).sort({ order: 1 }).toArray();
  const byId = ObjectId.isValid(r) && r.length === 24 ? all.filter((s) => hex(s._id) === r.toLowerCase()) : [];
  const hits = byId.length ? byId : all.filter((s) => s.name.toLowerCase() === r.toLowerCase());
  if (hits.length) return hits.map((s) => s._id);
  throw new UserError(`Unknown status "${r}". Statuses in this organisation's projects: ${[...new Set(all.map((s) => s.name))].join(", ")}.`);
}

/**
 * The names one project uses for the statuses Vector's texts talk about (VEC-116), so a wake-up or tool reply
 * still reads right when a project renamed them: `started` is where a bot's pickup moves the task (first started
 * status; null when the project has none, so nothing moves and texts must not name one, VEC-120), `done` / `cancelled` the first of those stages, `review` a started-stage status named like "review"
 * (null when the project has none), `unstarted` the first not-started status, `triage` the first triage status.
 */
export interface StatusWords {
  started: string | null;
  done: string;
  cancelled: string;
  review: string | null;
  unstarted: string;
  triage: string;
}

export const DEFAULT_STATUS_WORDS: StatusWords = { started: "In Progress", done: "Done", cancelled: "Cancelled", review: "In Review", unstarted: "Todo", triage: "Triage" };

export function statusWords(list: readonly { name: string; category: StatusCategory; order: number }[]): StatusWords {
  const sorted = [...list].sort((a, b) => a.order - b.order);
  const first = (stage: StatusCategory) => sorted.find((s) => s.category === stage)?.name;
  const started = sorted.filter((s) => s.category === "started");
  return {
    started: started[0]?.name ?? null,
    done: first("done") ?? DEFAULT_STATUS_WORDS.done,
    cancelled: first("cancelled") ?? DEFAULT_STATUS_WORDS.cancelled,
    review: started.find((s, i) => i > 0 && /review/i.test(s.name))?.name ?? null,
    unstarted: first("unstarted") ?? DEFAULT_STATUS_WORDS.unstarted,
    triage: first("triage") ?? DEFAULT_STATUS_WORDS.triage,
  };
}

/** statusWords for one project, read from the DB. */
export async function loadStatusWords(orgId: ObjectId, projectId: ObjectId): Promise<StatusWords> {
  return statusWords(await loadStatuses(orgId, projectId));
}

/** "In Review" as a status to name in a text, or a stage-worded fallback when the project has no review status. */
export const reviewWord = (w: StatusWords) => w.review ?? `an open status other than ${w.done}`;

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
