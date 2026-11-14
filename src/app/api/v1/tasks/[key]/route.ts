import { botRoute, parsePriority, parseType, readJson, resolveAssignee, resolveProject, resolveStatus, toDescriptionHtml } from "@/lib/bot-api";
import { findTaskByKey, loadFeed, toTaskDetail } from "@/lib/data";
import { UserError } from "@/lib/result";
import { updateTaskAs } from "@/lib/task-service";

/** GET /api/v1/tasks/WEB-12: the task with its description and activity. */
export const GET = botRoute<{ key: string }>(async (_req, ctx, { key }) => {
  const found = await findTaskByKey(ctx.org._id, key);
  if (!found) throw new UserError(`Unknown task "${key}".`);
  return { task: toTaskDetail(found.task, found.project.key), activity: await loadFeed(found.task._id) };
});

/** PATCH /api/v1/tasks/WEB-12  Bots can edit tasks they created. */
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
  });
  return { task };
});
