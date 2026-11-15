import "server-only";
import type { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { toTask, withWorkingBots } from "@/lib/data";
import { publish } from "@/lib/realtime/server";
import type { TaskDoc } from "@/lib/types";

/**
 * A bot started, finished or dropped work on these tasks (an `agentClaims` change). Open clients get a
 * task.upsert so "bot is working" shows or clears without a refresh; publish() fills `workingBotIds`.
 * Pass `workingOnly: false` when something else about the tasks changed too (e.g. they were unassigned).
 */
export async function publishWorking(orgId: ObjectId, actorId: ObjectId, taskIds: ObjectId[], opts: { workingOnly?: boolean } = {}) {
  if (!taskIds.length) return;
  try {
    const c = await cols();
    const docs = await c.tasks.find({ _id: { $in: taskIds }, orgId }, { projection: { description: 0 } }).toArray();
    if (!docs.length) return;
    const projects = await c.projects.find({ orgId }, { projection: { key: 1 } }).toArray();
    const keys = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
    // One claims query for the lot, not one per task.
    const tasks = await withWorkingBots(docs.map((d) => toTask(d as TaskDoc, keys.get(d.projectId.toHexString()) ?? "?")));
    const orgHex = orgId.toHexString();
    const actor = actorId.toHexString();
    for (const task of tasks) {
      await publish(orgHex, { type: "task.upsert", actorId: actor, task, workingOnly: opts.workingOnly ?? true }, { workingLoaded: true });
    }
  } catch (err) {
    // Best-effort, like all real-time: the claim change already happened.
    console.error("[realtime] working-state publish failed", err);
  }
}
