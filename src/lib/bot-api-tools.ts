import "server-only";
import type { BotCtx } from "@/lib/bot-api";
import { callTool } from "@/lib/mcp/server";

/**
 * REST endpoints that are the same action as an MCP tool (VEC-176: /tasks/{key}/complete, /advance) run the tool
 * itself for the calling bot, so both share one implementation, the same rules and the same reply text.
 * Tool refusals map to 404 (unknown task), 403 (rights / role) or 400 (anything else).
 */
export async function runAsTool(req: Request, ctx: BotCtx, tool: string, args: Record<string, unknown>) {
  const r = await callTool(tool, args, { ...ctx, origin: new URL(req.url).origin });
  const message = r.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
  if (!r.isError) return { message };
  const status = /there's no task|isn't a task key/i.test(message) ? 404 : /^only |role doesn't allow/i.test(message) ? 403 : 400;
  return Response.json({ error: message }, { status });
}
