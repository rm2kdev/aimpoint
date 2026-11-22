// VEC-407 backfill. No "server-only" and no path aliases (like flows-migration.ts), so a one-off node script can run
// the same update against the live database while the dev server's cached init has already run.
import type { Db, ObjectId } from "mongodb";
import { selectBackfill, type BackfillTask } from "./parent-link-core";

export const TASK_PARENT_MIGRATION = "2026-11-task-parent";

interface Row {
  _id: ObjectId;
  orgId: ObjectId;
  createdBy: ObjectId;
  createdAt: Date;
  dependsOn?: ObjectId[];
  triagedBy?: ObjectId | null;
  parentId?: ObjectId | null;
  createdByBot?: boolean;
}

/**
 * What the backfill would write: `parents` (child id -> parent id, see selectBackfill in parent-link-core.ts) and
 * `bots` (ids of tasks created by a bot that aren't marked `createdByBot` yet: the creator is a bot of the org, or the
 * bot that triaged some task, which also covers bots deleted since). Read-only.
 */
export async function planTaskParents(db: Db) {
  const tasks = db.collection<Row>("tasks");
  const rows = await tasks
    .find({}, { projection: { orgId: 1, createdBy: 1, createdAt: 1, dependsOn: 1, triagedBy: 1, parentId: 1, createdByBot: 1 } })
    .toArray();
  const list: BackfillTask[] = rows.map((t) => ({
    id: t._id.toHexString(),
    orgId: t.orgId.toHexString(),
    createdBy: t.createdBy.toHexString(),
    createdAt: new Date(t.createdAt).getTime(),
    dependsOn: (t.dependsOn ?? []).map((d) => d.toHexString()),
    triagedBy: t.triagedBy?.toHexString() ?? null,
    parentId: t.parentId?.toHexString() ?? null,
  }));
  const parents = selectBackfill(list);
  const botIds = new Set((await db.collection("bots").find({}, { projection: { _id: 1 } }).toArray()).map((b) => (b._id as ObjectId).toHexString()));
  for (const t of rows) if (t.triagedBy) botIds.add(t.triagedBy.toHexString());
  const bots = rows.filter((t) => !t.createdByBot && botIds.has(t.createdBy.toHexString())).map((t) => t._id);
  return { parents, bots, byId: new Map(rows.map((t) => [t._id.toHexString(), t._id])) };
}

/** Writes the plan. Idempotent: only tasks with no parent get one, and running it again finds nothing to do. */
export async function backfillTaskParents(db: Db, opts: { dryRun?: boolean } = {}) {
  const { parents, bots, byId } = await planTaskParents(db);
  if (opts.dryRun) return { parents: parents.size, bots: bots.length, written: { parents: 0, bots: 0 } };
  const tasks = db.collection<Row>("tasks");
  const ops = [...parents].map(([child, parent]) => ({
    updateOne: { filter: { _id: byId.get(child)!, $or: [{ parentId: null }, { parentId: { $exists: false } }] }, update: { $set: { parentId: byId.get(parent)! } } },
  }));
  const p = ops.length ? await tasks.bulkWrite(ops) : null;
  const b = bots.length ? await tasks.updateMany({ _id: { $in: bots } }, { $set: { createdByBot: true } }) : null;
  return { parents: parents.size, bots: bots.length, written: { parents: p?.modifiedCount ?? 0, bots: b?.modifiedCount ?? 0 } };
}
