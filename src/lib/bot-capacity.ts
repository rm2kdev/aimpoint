import "server-only";
import type { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { getEntitlements, getPlan, PLAN_LABEL, PRO_PRICE_LABEL } from "@/lib/billing";
import { isClosedCategory, type OrgDoc } from "@/lib/types";

/**
 * Plan limit on simultaneous bot work (VEC-225). On the Free plan a bot works on one task at a time; Pro and
 * self-hosted (billing off) have no limit, and then nothing here runs a query.
 *
 * A bot's slot is taken by:
 * - an in-progress claim (assigned work, triage, a mention that handed work back) on an open, unarchived task;
 * - a close-out it was handed and hasn't resolved yet (closeout.deliveredAt set, resolvedAt unset);
 * - a gated wake-up being delivered or retried (botWakes `gated`, not `heldAt`, not given up), so a second hand-off
 *   doesn't go out while the first is still on its way.
 * Wake-ups that would pass the limit are kept in the queue as held (`heldAt`) and sent, oldest first, when the slot
 * frees (lib/wake-queue.ts releaseHeld).
 */

type OrgLike = Pick<OrgDoc, "_id" | "billing">;

const hex = (id: ObjectId) => id.toHexString();

/** Tasks one bot of this org may work on at once; null = unlimited. */
export function concurrencyLimit(org: Pick<OrgDoc, "billing">): number | null {
  return getEntitlements(org).maxConcurrentBotTasks;
}

/** The tasks `botId` is busy with now (see above), leaving out `except` (the task being handed over). */
export async function busyWith(orgId: ObjectId, botId: ObjectId, except?: ObjectId): Promise<ObjectId[]> {
  const c = await cols();
  const notThis = except ? { taskId: { $ne: except } } : {};
  const [claims, wakes, closeouts] = await Promise.all([
    c.agentClaims.find({ orgId, botId, state: "in_progress", ...notThis }, { projection: { taskId: 1 } }).toArray(),
    c.botWakes.find({ orgId, botId, gated: true, heldAt: null, failedAt: null, ...notThis }, { projection: { taskId: 1 } }).toArray(),
    c.tasks
      .find({ orgId, "closeout.botId": botId, "closeout.deliveredAt": { $ne: null }, "closeout.resolvedAt": null, ...(except ? { _id: { $ne: except } } : {}) }, { projection: { _id: 1 } })
      .toArray(),
  ]);
  const ids = [...new Map([...claims.map((x) => x.taskId), ...wakes.map((x) => x.taskId), ...closeouts.map((t) => t._id)].map((id) => [hex(id), id])).values()];
  if (!ids.length) return [];
  // Only open, unarchived, unstopped tasks count: a claim left behind on a closed task holds nothing.
  const tasks = await c.tasks.find({ _id: { $in: ids }, orgId, archivedAt: null, stopped: null }, { projection: { statusId: 1 } }).toArray();
  if (!tasks.length) return [];
  const statuses = await c.statuses.find({ _id: { $in: tasks.map((t) => t.statusId) } }, { projection: { category: 1 } }).toArray();
  const open = new Set(statuses.filter((s) => !isClosedCategory(s.category)).map((s) => hex(s._id)));
  return tasks.filter((t) => open.has(hex(t.statusId))).map((t) => t._id);
}

/** Would one more task for `botId` (other than `except`) pass its org's plan limit? Always false without a limit. */
export async function atCapacity(org: OrgLike, botId: ObjectId, except?: ObjectId): Promise<boolean> {
  const limit = concurrencyLimit(org);
  if (limit === null) return false;
  return (await busyWith(org._id, botId, except)).length >= limit;
}

/** "On the Free plan a bot works on one task at a time." plus the upgrade line, for agent-facing notes. */
export function planLimitText(org: Pick<OrgDoc, "billing">): string {
  const limit = concurrencyLimit(org) ?? 0;
  const plan = PLAN_LABEL[getPlan(org)];
  const count = limit === 1 ? "one task" : `${limit} tasks`;
  return `On the ${plan} plan a bot works on ${count} at a time. An admin can upgrade to Pro (${PRO_PRICE_LABEL}) in Settings > Billing for bots that work on several tasks at once.`;
}

/** What check_for_work / check_for_triage return about the limit (null when the plan has none). */
export function planLimitInfo(org: Pick<OrgDoc, "billing">, waiting: number) {
  const limit = concurrencyLimit(org);
  if (limit === null) return null;
  return { plan: getPlan(org), maxConcurrentTasks: limit, waiting };
}
