"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { useOrgBase } from "@/components/org-provider";
import { taskAccess } from "@/lib/access";
import { timeAgo } from "@/lib/format";
import { isClosedCategory, type Member, type RetryOutcome, type Task } from "@/lib/types";
import { retryTask } from "@/app/actions/tasks";

/**
 * Retry / unstall (VEC-159): hand a task to its bot again when the bot's run stopped, or, for a task waiting on
 * others, retry the front of its chain so the rest follow in dependency order. See lib/retry-handoff.ts.
 */

/** Whether to offer Retry on this task: open, ready-or-chained, and the viewer may work on it. */
export function useCanRetry(task: Pick<Task, "statusId" | "assigneeId" | "archivedAt" | "waitingOn" | "createdBy" | "stopped"> | null) {
  const { me, isAdmin, statusById, memberById } = useOrgBase();
  // A stopped task (VEC-215) is handed back with Resume; the server refuses Retry.
  if (!task || task.archivedAt || task.stopped) return false;
  const cat = statusById.get(task.statusId)?.category;
  if (!cat || cat === "triage" || isClosedCategory(cat)) return false;
  if (taskAccess(task, me.id, isAdmin) === "comment") return false;
  const assignee = task.assigneeId ? memberById.get(task.assigneeId) : undefined;
  if (task.waitingOn.length > 0) return true; // retries the chain's front, whoever holds this one
  // VEC-353: a disabled bot can't be handed work; callers show the disabled note (retryDisabledBot) instead.
  return assignee?.kind === "bot" && !assignee.disabled;
}

/** The disabled bot holding this task when that's why Retry is hidden (VEC-353), else null. */
export function useRetryDisabledBot(task: Pick<Task, "statusId" | "assigneeId" | "archivedAt" | "waitingOn" | "stopped"> | null): Member | null {
  const { statusById, memberById } = useOrgBase();
  if (!task || task.archivedAt || task.stopped || task.waitingOn.length > 0) return null;
  const cat = statusById.get(task.statusId)?.category;
  if (!cat || cat === "triage" || isClosedCategory(cat)) return null;
  const assignee = task.assigneeId ? memberById.get(task.assigneeId) : undefined;
  return assignee?.kind === "bot" && assignee.disabled ? assignee : null;
}

/** Milliseconds since `iso` (outside render code, so components can call it on a timer tick). */
export const msSince = (iso: string) => Date.now() - new Date(iso).getTime();

/** A working bot that hasn't posted for this long may have lost its run: the pane suggests a retry. */
export const QUIET_HINT_MS = 20 * 60_000;

/** Calls the retry action and reports what happened; a busy bot gets a "Retry anyway" toast. */
export function useRetryTask() {
  const { org, memberById } = useOrgBase();
  return useCallback((task: Pick<Task, "id" | "key">, force = false) => runRetry(org.slug, (id) => memberById.get(id)?.name ?? "its bot", task, force), [org.slug, memberById]);
}

async function runRetry(slug: string, bot: (id: string) => string, task: Pick<Task, "id" | "key">, force: boolean): Promise<RetryOutcome | null> {
  const res = await retryTask(slug, task.id, force);
  if (!res.ok || !res.data) {
    toast.error(res.ok ? "Couldn't retry it." : res.error);
    return null;
  }
  const out = res.data;
  const skipped = out.skipped;
  // VEC-352/353: a disabled bot's tasks aren't handed out (nothing queued). The button is hidden for those, but a chain
  // front or a toggle that raced the click can still land here: say so in a toast of its own.
  const disabled = out.disabled ?? [];
  if (disabled.length) {
    const bots = [...new Set(disabled.map((d) => d.bot))];
    toast.error(bots.length === 1 ? `${bots[0]} is disabled` : `${bots.join(", ")} are disabled`, {
      description: disabled.length === 1 ? `${disabled[0].key}: ${disabled[0].why}` : `Not handed out: ${disabled.map((d) => d.key).join(", ")}. Enable the bot in Settings > Bots, then retry.`,
      duration: 8000,
    });
  }
  if (out.retried.length === 1) {
    const [r] = out.retried;
    toast.success(`Handed ${r.key} to ${bot(r.botId)} again`, { description: r.key === task.key ? undefined : `${task.key} follows once it's done.` });
  } else if (out.retried.length > 1) {
    toast.success(`Retried ${out.retried.map((r) => r.key).join(", ")}`, { description: `${task.key} follows once they're done.` });
  }
  if (out.busy.length) {
    const b = out.busy;
    const lead =
      b.length === 1
        ? `${bot(b[0].botId)} posted on ${b[0].key} ${timeAgo(b[0].lastAt) === "now" ? "just now" : timeAgo(b[0].lastAt)}`
        : `${b.map((x) => x.key).join(", ")} had bot activity in the last few minutes`;
    toast(`${lead} and may still be working.`, {
      description: "Retrying starts a fresh run beside it.",
      action: { label: "Retry anyway", onClick: () => void runRetry(slug, bot, task, true) },
      duration: 10_000,
    });
  }
  if (!out.retried.length && !out.busy.length) {
    if (disabled.length && !skipped.length) return out;
    toast.error(
      skipped.length
        ? `Nothing to retry: ${skipped.map((s) => `${s.key} (${s.why})`).join("; ")}.`
        : "Nothing to retry: nothing it's waiting on can be handed out right now.",
    );
  } else if (skipped.length) {
    toast(`Not retried: ${skipped.map((s) => `${s.key} (${s.why})`).join("; ")}.`);
  }
  return out;
}
