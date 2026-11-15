import { botRoute, parsePriority, parseType, readJson, resolveAssignee, resolveProject, resolveStatus, resolveTaskRefs, toDescriptionHtml } from "@/lib/bot-api";
import { findTaskByKey, loadFeed, toTaskDetail, withWorkingBots } from "@/lib/data";
import { loadTaskRefs } from "@/lib/dependencies";
import { UserError } from "@/lib/result";
import { updateTaskAs } from "@/lib/task-service";

/** GET /api/v1/tasks/WEB-12: the task with its description and activity. */
export const GET = botRoute<{ key: string }>(async (_req, ctx, { key }) => {
  const found = await findTaskByKey(ctx.org._id, key);
  if (!found) throw new UserError(`Unknown task "${key}".`);
  const [refs, activity] = await Promise.all([loadTaskRefs(ctx.org._id, found.task), loadFeed(found.task._id)]);
  const [task] = await withWorkingBots([toTaskDetail(found.task, found.project.key, refs)]);
  return { task, activity };
}, "get_task");

/** PATCH /api/v1/tasks/WEB-12  Same rights as a person: creator edits anything, assignee moves and sets details. `dependsOn` replaces the list. */
export const PATCH = botRoute<{ key: string }>(async (req, ctx, { key }) => {
  const found = await findTaskByKey(ctx.org._id, key);
  if (!found) throw new UserError(`Unknown task "${key}".`);
  const b = await readJson(req);
  const task = await updateTaskAs(ctx.actor, found.task._id, {
    title: b.title === undefined ? undefined : String(b.title),
    description: toDescriptionHtml(b.description),
    type: parseType(b.type),
    statusId: await resolveStatus(ctx.org._id, b.status),
    assigneeId: await resolveAssignee(ctx, b.assignee),
    priority: parsePriority(b.priority),
    projectId: b.project === undefined ? undefined : (await resolveProject(ctx.org._id, b.project))._id.toHexString(),
    dueDate: b.dueDate === undefined ? undefined : (b.dueDate as string | null),
    archived: b.archived === undefined ? undefined : Boolean(b.archived),
    dependsOn: await resolveTaskRefs(ctx.org._id, b.dependsOn),
  });
  return { task };
}, "update_task");
