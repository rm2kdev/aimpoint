import { ObjectId, type Filter } from "mongodb";
import {
  botRoute,
  parsePriority,
  parseType,
  readJson,
  resolveAssignee,
  resolveProject,
  resolveStatus,
  resolveStatusFilter,
  resolveTaskRefs,
  toDescriptionHtml,
} from "@/lib/bot-api";
import { cols } from "@/lib/db";
import { toTask, withWorkingBots } from "@/lib/data";
import { assignedBlockersOf, createTaskAs } from "@/lib/task-service";
import type { TaskDoc } from "@/lib/types";
import { UserError } from "@/lib/result";

/** A REST `parent` key or id -> task id; unknown is a 400 naming the field. */
async function resolveParentRef(orgId: ObjectId, v: unknown): Promise<string> {
  if (typeof v !== "string") throw new UserError("`parent` is a task key like \"WEB-12\", or null.");
  try {
    return (await resolveTaskRefs(orgId, [v]))![0];
  } catch {
    throw new UserError(`Unknown task "${v}" in \`parent\`.`);
  }
}

/**
 * GET /api/v1/tasks?project=WEB&assignee=me&status=Todo&archived=true&limit=50  (archived tasks are excluded unless archived=true).
 * VEC-407: `topLevel=true` leaves sub-tasks out (only tasks with no parent); `parent=WEB-12` lists WEB-12's sub-tasks.
 * Statuses are per project: with `project`, `status` must be one of that project's (400 otherwise); without it,
 * `status` matches every project's status of that name.
 */
export const GET = botRoute(async (req, ctx) => {
  const q = new URL(req.url).searchParams;
  const filter: Filter<TaskDoc> = { orgId: ctx.org._id, archivedAt: q.get("archived") === "true" ? { $ne: null } : null };
  if (q.get("project")) filter.projectId = (await resolveProject(ctx.org._id, q.get("project")))._id;
  const status = await resolveStatusFilter(ctx.org._id, q.get("status"), filter.projectId as ObjectId | undefined);
  if (status) filter.statusId = { $in: status };
  const assignee = await resolveAssignee(ctx, q.get("assignee") ?? undefined);
  if (assignee !== undefined) filter.assigneeId = assignee ? new ObjectId(assignee) : null;
  const parent = q.get("parent");
  if (parent && q.get("topLevel") === "true") throw new UserError("Pass `topLevel` or `parent`, not both.");
  if (parent) {
    filter.parentId = new ObjectId(await resolveParentRef(ctx.org._id, parent));
  } else if (q.get("topLevel") === "true") filter.parentId = null;
  const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200);
  const c = await cols();
  const [docs, projects] = await Promise.all([
    c.tasks.find(filter, { projection: { description: 0 } }).sort({ updatedAt: -1 }).limit(limit).toArray(),
    c.projects.find({ orgId: ctx.org._id }).toArray(),
  ]);
  const keys = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
  return { tasks: await withWorkingBots(docs.map((d) => toTask(d as TaskDoc, keys.get(d.projectId.toHexString()) ?? "?"))) };
}, "list_tasks");

/**
 * POST /api/v1/tasks  { title, project, type?: "issue" | "feature" | "task" (default "issue"), description?, status?, assignee?, priority?, dueDate?, dependsOn?: ["WEB-12"], parent?: "WEB-10" | null }
 * `parent` (VEC-407): the task it's a sub-task of (one level). Omitted = the one task the bot is working on, if any;
 * null or "none" = top-level.
 * `status` is a name (or stage, or id) of that project's own statuses (GET /api/v1/statuses?project=WEB); another
 * project's status is a 400. Defaults to the project's first not-started status.
 */
export const POST = botRoute(async (req, ctx) => {
  const b = await readJson(req);
  const project = await resolveProject(ctx.org._id, b.project);
  const task = await createTaskAs(ctx.actor, {
    title: String(b.title ?? ""),
    projectId: project._id.toHexString(),
    type: parseType(b.type) ?? "issue",
    statusId: await resolveStatus(ctx.org._id, b.status, project._id),
    assigneeId: (await resolveAssignee(ctx, b.assignee)) ?? null,
    priority: parsePriority(b.priority),
    description: toDescriptionHtml(b.description),
    dueDate: b.dueDate == null ? null : String(b.dueDate),
    dependsOn: await resolveTaskRefs(ctx.org._id, b.dependsOn),
    parentId: b.parent === undefined ? undefined : b.parent === null || String(b.parent).trim().toLowerCase() === "none" || String(b.parent).trim() === "" ? null : (await resolveParentRef(ctx.org._id, b.parent)),
  });
  const assigned = assignedBlockersOf(task);
  // VEC-107: open dependencies nobody owned, now assigned to the calling bot because its own task waits on them.
  return Response.json({ task, ...(assigned.length ? { assignedBlockers: assigned } : {}) }, { status: 201 });
}, "create_task");
