import { botRoute, readJson } from "@/lib/bot-api";
import { runAsTool } from "@/lib/bot-api-tools";

/**
 * POST /api/v1/tasks/WEB-12/complete  `{ "comment"?: "…", "status"?: "Done" }`: the REST form of MCP complete_task
 * (VEC-176). On a task with an active flow, leave `status` out to hand it to the next step's owner; the reply's
 * `message` says where it went and who has it now. Without an active flow, omitting `status` moves nothing.
 */
export const POST = botRoute<{ key: string }>(async (req, ctx, { key }) => {
  const b = await readJson(req);
  return runAsTool(req, ctx, "complete_task", {
    task: key,
    ...(b.comment !== undefined ? { comment: b.comment } : {}),
    ...(b.status !== undefined ? { status: b.status } : {}),
  });
}, "complete_task");
