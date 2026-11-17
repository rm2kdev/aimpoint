import { botRoute, readJson } from "@/lib/bot-api";
import { runAsTool } from "@/lib/bot-api-tools";

/**
 * POST /api/v1/tasks/WEB-12/advance  `{ "comment"?: "Reply received: …" }`: the REST form of MCP advance_task
 * (VEC-176). Moves a task on from a flow wait step once what it waits for has happened; for the step's owner, its
 * resolver bots and the task's assignee or creator. Other steps answer 400 (use /complete).
 */
export const POST = botRoute<{ key: string }>(async (req, ctx, { key }) => {
  const b = await readJson(req).catch(() => ({}) as Record<string, unknown>);
  return runAsTool(req, ctx, "advance_task", { task: key, ...(b.comment !== undefined ? { comment: b.comment } : {}) });
}, "advance_task");
