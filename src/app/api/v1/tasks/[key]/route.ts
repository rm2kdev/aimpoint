import { botRoute, parsePriority, parseType, readJson, resolveAssignee, resolveProject, resolveStatus, resolveTaskRefs, toDescriptionHtml } from "@/lib/bot-api";
import { findTaskByKey, loadFeed, toTaskDetail, withWorkingBots } from "@/lib/data";
import { loadTaskRefs } from "@/lib/dependencies";
import { UserError } from "@/lib/result";
import { assignedBlockersOf, moveTask, updateTaskAs } from "@/lib/task-service";

/** GET /api/v1/tasks/WEB-12: the task with its description and activity. */
export const GET = botRoute<{ key: string }>(async (_req, ctx, { key }) => {
  const found = await findTaskByKey(ctx.org._id, key);
  if (!found) throw new UserError(`Unknown task "${key}".`);
  const [refs, activity] = await Promise.all([loadTaskRefs(ctx.org._id, found.task), loadFeed(found.task._id)]);
  const [task] = await withWorkingBots([toTaskDetail(found.task, found.project.key, refs)]);
  return { task, activity };
}, "get_task");

/** Fields that may go with `before` / `after` in one move (VEC-57). */
const MOVE_FIELDS = new Set(["before", "after", "status", "project"]);

/**
 * PATCH /api/v1/tasks/WEB-12  Same rights as a person: creator edits anything, assignee moves and sets details. `dependsOn` replaces the list.
 * `before` / `after` (task keys) reorder it in the shared manual order: it goes directly above `before` / below
 * `after`, optionally with `status` and `project` in the same write. Creator or admin only.
 */
export const PATCH = botRoute<{ key: string }>(async (req, ctx, { key }) => {
  const found = await findTaskByKey(ctx.org._id, key);
  if (!found) throw new UserError(`Unknown task "${key}".`);
  const b = await readJson(req);
  // Statuses resolve within the task's project, or the one it moves to (VEC-115).
  const dest = b.project === undefined ? undefined : (await resolveProject(ctx.org._id, b.project))._id;
  if (b.before !== undefined || b.after !== undefined) {
    const extra = Object.keys(b).filter((k) => !MOVE_FIELDS.has(k));
    if (extra.length) throw new UserError(`\`before\` / \`after\` can only be combined with \`status\` and \`project\` (got ${extra.join(", ")}).`);
    const task = await moveTask(ctx.actor, key, {
      beforeKey: b.before == null ? null : String(b.before),
      afterKey: b.after == null ? null : String(b.after),
      status: await resolveStatus(ctx.org._id, b.status, dest ?? found.task.projectId),
      project: dest?.toHexString(),
    });
    return { task };
  }
  const task = await updateTaskAs(ctx.actor, found.task._id, {
    title: b.title === undefined ? undefined : String(b.title),
    description: toDescriptionHtml(b.description),
    type: parseType(b.type),
    statusId: await resolveStatus(ctx.org._id, b.status, dest ?? found.task.projectId),
    assigneeId: await resolveAssignee(ctx, b.assignee),
    priority: parsePriority(b.priority),
    projectId: dest?.toHexString(),
    dueDate: b.dueDate === undefined ? undefined : (b.dueDate as string | null),
    archived: b.archived === undefined ? undefined : Boolean(b.archived),
    dependsOn: await resolveTaskRefs(ctx.org._id, b.dependsOn),
  });
  const assigned = assignedBlockersOf(task);
  // VEC-107: open dependencies nobody owned, now assigned to the calling bot because its own task waits on them.
  return { task, ...(assigned.length ? { assignedBlockers: assigned } : {}) };
}, "update_task");
