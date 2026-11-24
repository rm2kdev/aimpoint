import { getTaskDetail } from "@/app/actions/tasks";

export const dynamic = "force-dynamic";

/**
 * GET /api/task-detail?org=<slug>&key=<KEY>: the task pane's data (task + feed) for the signed-in member, the same
 * `Result` as the getTaskDetail server action (VEC-458). A plain fetch, not a server action: Next runs server actions
 * one at a time in its router queue, so reading the pane through one waited behind every edit still on its way.
 */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const r = await getTaskDetail(q.get("org") ?? "", q.get("key") ?? "");
  return Response.json(r, { headers: { "Cache-Control": "no-store" } });
}
