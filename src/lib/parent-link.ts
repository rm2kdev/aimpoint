import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { isClosedCategory } from "@/lib/types";
import { autoParentId, checkParentLink, type ClaimedTask } from "@/lib/parent-link-core";

/** Who is creating the task: the parent rules only need the org, the actor and whether it's a bot. */
interface ParentActor {
  orgId: ObjectId;
  id: ObjectId;
  isBot?: boolean;
}

/**
 * The parent for a new task (VEC-407, rules in lib/parent-link-core.ts). `explicit`: a task id from the caller's
 * `parent` (wins), null = none on purpose, undefined = automatic. Automatic only applies to bots: the task their
 * in-progress claims (triage or work) lead to, if exactly one. An explicit parent that breaks the rules is a UserError;
 * an automatic one that would (archived, say) is just left unset.
 */
export async function parentForCreate(actor: ParentActor, explicit: string | null | undefined): Promise<ObjectId | null> {
  if (explicit === null) return null;
  const c = await cols();
  if (explicit !== undefined) {
    if (!ObjectId.isValid(explicit)) throw new UserError("Unknown parent task.");
    const parent = await c.tasks.findOne({ _id: new ObjectId(explicit), orgId: actor.orgId }, { projection: { projectId: 1, number: 1, parentId: 1, archivedAt: 1 } });
    if (!parent) throw new UserError("Unknown parent task.");
    const keys = await keysOf(actor.orgId, [parent._id, ...(parent.parentId ? [parent.parentId] : [])]);
    const check = checkParentLink(
      { id: null, key: null, hasChildren: false },
      {
        id: parent._id.toHexString(),
        key: keys.get(parent._id.toHexString()) ?? "That task",
        parentId: parent.parentId?.toHexString() ?? null,
        parentKey: parent.parentId ? (keys.get(parent.parentId.toHexString()) ?? null) : null,
        archived: !!parent.archivedAt,
      },
    );
    if (!check.ok) throw new UserError(check.error);
    return parent._id;
  }
  if (!actor.isBot) return null;
  return autoParent(actor);
}

/** The task a bot's in-progress claims lead to (see autoParentId), counting only open, unarchived tasks of its org. */
export async function autoParent(actor: ParentActor): Promise<ObjectId | null> {
  const c = await cols();
  const claims = await c.agentClaims.find({ botId: actor.id, orgId: actor.orgId, state: "in_progress" }, { projection: { taskId: 1 } }).toArray();
  if (!claims.length) return null;
  const tasks = await c.tasks
    .find({ _id: { $in: claims.map((cl) => cl.taskId) }, orgId: actor.orgId, archivedAt: null }, { projection: { statusId: 1, parentId: 1 } })
    .toArray();
  const statuses = await c.statuses.find({ _id: { $in: tasks.map((t) => t.statusId) } }, { projection: { category: 1 } }).toArray();
  const closed = new Set(statuses.filter((s) => isClosedCategory(s.category)).map((s) => s._id.toHexString()));
  const open: ClaimedTask[] = tasks.filter((t) => !closed.has(t.statusId.toHexString())).map((t) => ({ id: t._id.toHexString(), parentId: t.parentId?.toHexString() ?? null }));
  const id = autoParentId(open);
  if (!id) return null;
  // The root it leads to may be a parent we didn't load (the claim was on a sub-task): it must still be usable.
  const root = await c.tasks.findOne({ _id: new ObjectId(id), orgId: actor.orgId }, { projection: { parentId: 1, archivedAt: 1 } });
  return root && !root.archivedAt && !root.parentId ? root._id : null;
}

async function keysOf(orgId: ObjectId, ids: ObjectId[]) {
  const c = await cols();
  const docs = await c.tasks.find({ _id: { $in: ids }, orgId }, { projection: { projectId: 1, number: 1 } }).toArray();
  const projects = await c.projects.find({ _id: { $in: docs.map((d) => d.projectId) } }, { projection: { key: 1 } }).toArray();
  const pk = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
  return new Map(docs.map((d) => [d._id.toHexString(), `${pk.get(d.projectId.toHexString()) ?? "?"}-${d.number}`]));
}

/**
 * Tasks are about to be deleted (VEC-407): their sub-tasks stay, as top-level tasks (parentId cleared). Returns the
 * sub-tasks that changed so the caller can republish them. Archiving a parent doesn't come here: the link stays.
 */
export async function detachChildren(orgId: ObjectId, ids: ObjectId[]): Promise<ObjectId[]> {
  if (!ids.length) return [];
  const c = await cols();
  const children = (await c.tasks.find({ orgId, parentId: { $in: ids }, _id: { $nin: ids } }, { projection: { _id: 1 } }).toArray()).map((t) => t._id);
  if (children.length) await c.tasks.updateMany({ _id: { $in: children } }, { $set: { parentId: null } });
  return children;
}
