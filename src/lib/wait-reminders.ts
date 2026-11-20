import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { resolveOrgFlows } from "@/lib/flows";
import { locateStep } from "@/lib/flow-engine-core";
import { notify } from "@/lib/notifications";
import type { ResolvedFlow, ResolvedStep } from "@/lib/flow-model";
import { isClosedCategory, type TaskDoc } from "@/lib/types";

/**
 * Wait-step reminders (VEC-182, docs/flows.md 5.7). A task sitting at a wait step (`advance: "wait"`) longer than
 * the step's `wait.remindAfterDays` gets one `waiting` notification per entry into the step. `task.flow.remindedAt`
 * marks it sent (taken with a conditional update, so overlapping sweeps send it once); the flow engine writes a
 * fresh `task.flow` (new `enteredAt`, no `remindedAt`) whenever the task enters a step, so leaving the step and
 * coming back re-arms it, while edits that keep it on the step ("stay") don't.
 *
 * Recipients: the step's owner when that's a person; else the assignee if a person; else the task's creator if a
 * person in the org; else the org admins. Bots aren't notified (a bot owner was briefed on entry and is the one
 * expected to call advance_task).
 *
 * Paused tasks, archived ones, flows that are off, and closed statuses are skipped. The sweep runs every
 * SWEEP_MS in the long-lived server process (started when this module loads, like lib/wake-queue.ts); on Vercel,
 * /api/cron/wait-reminders runs it.
 */

const SWEEP_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;
const PER_SWEEP = 200;

const hex = (id: ObjectId) => id.toHexString();

/** The org's wait-step ids that have a reminder, from the stored flows (the org default and project overrides). */
async function reminderSteps(): Promise<Map<string, { orgId: ObjectId; stepIds: Set<string>; minDays: number }>> {
  const c = await cols();
  const flows = await c.flows
    .find({ steps: { $elemMatch: { advance: "wait", "wait.remindAfterDays": { $gt: 0 } } } }, { projection: { orgId: 1, steps: 1 } })
    .toArray();
  const out = new Map<string, { orgId: ObjectId; stepIds: Set<string>; minDays: number }>();
  for (const f of flows) {
    const entry = out.get(hex(f.orgId)) ?? { orgId: f.orgId, stepIds: new Set<string>(), minDays: Infinity };
    for (const s of f.steps) {
      const days = s.wait?.remindAfterDays;
      if (s.advance !== "wait" || !days || days <= 0) continue;
      entry.stepIds.add(s.id);
      entry.minDays = Math.min(entry.minDays, days);
    }
    if (entry.stepIds.size) out.set(hex(f.orgId), entry);
  }
  return out;
}

async function recipientsFor(orgId: ObjectId, task: Pick<TaskDoc, "assigneeId" | "createdBy">, step: ResolvedStep): Promise<ObjectId[]> {
  const c = await cols();
  const candidates: (ObjectId | null | undefined)[] = [
    step.owner.kind === "person" && step.owner.id && ObjectId.isValid(step.owner.id) ? new ObjectId(step.owner.id) : null,
    task.assigneeId,
    task.createdBy,
  ];
  for (const id of candidates) {
    if (!id) continue;
    if (await c.memberships.findOne({ orgId, userId: id }, { projection: { _id: 1 } })) return [id];
  }
  return (await c.memberships.find({ orgId, role: "admin" }, { projection: { userId: 1 } }).toArray()).map((m) => m.userId);
}

export function waitedDays(enteredAt: Date, now = Date.now()) {
  return Math.max(0, Math.floor((now - enteredAt.getTime()) / DAY_MS));
}

/** One pass. Also the body of /api/cron/wait-reminders. */
export async function sweepWaitReminders(now = new Date()): Promise<{ reminded: number }> {
  const c = await cols();
  const byOrg = await reminderSteps();
  let reminded = 0;
  for (const { orgId, stepIds, minDays } of byOrg.values()) {
    const tasks = await c.tasks
      .find(
        {
          orgId,
          "flow.stepId": { $in: [...stepIds] },
          "flow.paused": { $ne: true },
          "flow.enteredAt": { $lte: new Date(now.getTime() - minDays * DAY_MS) },
          $or: [{ "flow.remindedAt": null }, { "flow.remindedAt": { $exists: false } }],
          archivedAt: null,
        },
        { projection: { projectId: 1, statusId: 1, assigneeId: 1, createdBy: 1, flow: 1 } },
      )
      .limit(PER_SWEEP)
      .toArray();
    if (!tasks.length) continue;
    const [flows, statuses] = await Promise.all([
      resolveOrgFlows(orgId),
      c.statuses.find({ orgId, _id: { $in: [...new Set(tasks.map((t) => hex(t.statusId)))].map((id) => new ObjectId(id)) } }).toArray(),
    ]);
    const statusById = new Map(statuses.map((s) => [hex(s._id), s]));
    for (const t of tasks) {
      const flow: ResolvedFlow | null | undefined = flows.get(hex(t.projectId));
      const status = statusById.get(hex(t.statusId));
      if (!flow || !status || isClosedCategory(status.category) || !t.flow) continue;
      const step = locateStep(flow, { id: hex(status._id), name: status.name, category: status.category, order: status.order }, t.flow.stepId);
      const days = step?.advance === "wait" ? step.wait?.remindAfterDays : null;
      if (!step || step.id !== t.flow.stepId || !days || days <= 0) continue;
      const enteredAt = new Date(t.flow.enteredAt);
      if (now.getTime() - enteredAt.getTime() < days * DAY_MS) continue;
      // Once per entry: only the sweep that flips remindedAt sends, and only for this same entry.
      const taken = await c.tasks.updateOne(
        { _id: t._id, orgId, "flow.stepId": step.id, "flow.enteredAt": t.flow.enteredAt, $or: [{ "flow.remindedAt": null }, { "flow.remindedAt": { $exists: false } }] },
        { $set: { "flow.remindedAt": now } },
      );
      if (!taken.modifiedCount) continue;
      const label = step.wait?.label?.trim() || step.name;
      const waited = waitedDays(enteredAt, now.getTime());
      await notify(orgId, await recipientsFor(orgId, t, step), {
        kind: "waiting",
        taskId: t._id,
        actorId: null,
        detail: `Waiting ${waited} day${waited === 1 ? "" : "s"} at ${step.name}: ${label}`.slice(0, 200),
      });
      reminded++;
    }
  }
  return { reminded };
}

type SweepState = { timer?: ReturnType<typeof setInterval>; running?: boolean; run?: () => Promise<unknown> };
const g = globalThis as unknown as { __aimpointWaitReminders?: SweepState };

/** Runs the sweep every SWEEP_MS in this process (not on Vercel, not during a build). Safe to call repeatedly. */
export function startWaitReminderSweeper() {
  const st = (g.__aimpointWaitReminders ??= {});
  st.run = () => sweepWaitReminders(); // after a dev reload the timer calls the new code
  if (st.timer || process.env.VERCEL || process.env.NEXT_PHASE === "phase-production-build" || process.env.AIMPOINT_WAKE_SWEEP === "off") return;
  st.timer = setInterval(async () => {
    if (st.running) return;
    st.running = true;
    try {
      await st.run?.();
    } catch (err) {
      console.error("[wait reminders]", err);
    } finally {
      st.running = false;
    }
  }, SWEEP_MS);
  st.timer.unref?.();
}

startWaitReminderSweeper();
