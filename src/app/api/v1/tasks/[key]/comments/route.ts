import { botRoute, readJson } from "@/lib/bot-api";
import { findTaskByKey } from "@/lib/data";
import { UserError } from "@/lib/result";
import { addCommentAs } from "@/lib/task-service";

/** POST /api/v1/tasks/WEB-12/comments  { body }  Any bot in the org can comment. */
export const POST = botRoute<{ key: string }>(async (req, ctx, { key }) => {
  const found = await findTaskByKey(ctx.org._id, key);
  if (!found) throw new UserError(`Unknown task "${key}".`);
  const b = await readJson(req);
  const comment = await addCommentAs(ctx.actor, found.task._id, String(b.body ?? ""));
  return Response.json({ comment }, { status: 201 });
}, "add_comment");
