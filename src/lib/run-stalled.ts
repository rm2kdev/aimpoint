import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { loadTaskFlow } from "@/lib/flow-engine";
import { nextStepOf, stepDriven } from "@/lib/flow-engine-core";
import { finishedAtStep, isUnfinishedClaim } from "@/lib/run-watch-core";
import type { Stalled, Task } from "@/lib/types";

/**
 * VEC-316: the Stalled states that don't need a waiting task, added on top of loadStalled's (data.ts):
 * - "unfinished": the assignee bot's run ended twice without complete_task (lib/unfinished-runs.ts marked its claim),
 *   so nobody is moving the task. Wins over "finished"; "undelivered" (the bot was never reached) still wins over it.
 * - "finished" with no waiters: a flow task its bot finished (claim done) that is still at the same step with no
 *   hand-off, on a step the flow drives (finishedAtStep). Without waiters this used to show nothing at all.
 * `out` is filled in place.
 */
export async function addRunStalls(tasks: Task[], out: Map<string, Stalled>) {
  const cands = tasks.filter((t) => !t.archivedAt && !t.workingBotIds.length && t.assigneeId && out.get(t.id)?.reason !== "undelivered");
  if (!cands.length) return;
  const c = await cols();
  const claims = await c.agentClaims
    .find({ taskId: { $in: cands.map((t) => new ObjectId(t.id)) }, state: "done", kind: { $ne: "triage" } }, { projection: { taskId: 1, botId: 1, state: 1, finishedAt: 1, unfinishedAt: 1 } })
    .toArray();
  if (!claims.length) return;
  const byTask = new Map(claims.map((cl) => [`${cl.taskId.toHexString()}:${cl.botId.toHexString()}`, cl]));
  const mine = cands.filter((t) => byTask.has(`${t.id}:${t.assigneeId}`));
  if (!mine.length) return;
  const statuses = await c.statuses.find({ _id: { $in: [...new Set(mine.map((t) => t.statusId))].map((id) => new ObjectId(id)) } }, { projection: { category: 1 } }).toArray();
  const open = new Set(statuses.filter((s) => s.category !== "done" && s.category !== "cancelled" && s.category !== "triage").map((s) => s._id.toHexString()));
  const finishedOnly: Task[] = [];
  for (const t of mine) {
    if (!open.has(t.statusId)) continue;
    const claim = byTask.get(`${t.id}:${t.assigneeId}`)!;
    const had = out.get(t.id);
    if (isUnfinishedClaim(claim)) out.set(t.id, { reason: "unfinished", botId: t.assigneeId, blocking: had?.blocking ?? [] });
    else if (!had && !t.waitingOn.length) finishedOnly.push(t);
  }
  if (!finishedOnly.length) return;
  const docs = await c.tasks
    .find({ _id: { $in: finishedOnly.map((t) => new ObjectId(t.id)) } }, { projection: { orgId: 1, projectId: 1, statusId: 1, flow: 1, closeout: 1 } })
    .toArray();
  for (const d of docs) {
    const t = finishedOnly.find((x) => x.id === d._id.toHexString())!;
    if (d.flow?.paused) continue;
    const ctx = await loadTaskFlow(d);
    if (!ctx?.current) continue;
    const step = ctx.current;
    const closeoutPending = !!d.closeout && !d.closeout.resolvedAt && d.closeout.botId.toHexString() === t.assigneeId;
    if (
      finishedAtStep({ driven: stepDriven(ctx.flow, step), wait: step.advance === "wait", paused: false, lastStep: !nextStepOf(ctx.flow, step), waiting: false, closeoutPending })
    )
      out.set(t.id, { reason: "finished", botId: t.assigneeId, blocking: [] });
  }
}
