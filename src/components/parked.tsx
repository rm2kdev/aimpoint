"use client";

import { PauseIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOrgBase } from "@/components/org-provider";
import { isParkedStatus, locateStep } from "@/lib/flow-engine-core";
import type { Member, Task } from "@/lib/types";

/**
 * VEC-276: the client side of the parked-Backlog rule (VEC-274, `isParked` in lib/flow-engine.ts). A task in a
 * backlog-stage status is parked unless its flow's current step sits in that status and names its owner, so a bot
 * assigned to it is held until someone moves it to a not-started or started status. Returns the status name when
 * a task with this project / status / flow position is parked, else null. Works before the task exists (the
 * new-task dialog passes no `flow`).
 */
export function useParkedIn(projectId: string | null | undefined, statusId: string | null | undefined, flow?: Task["flow"] | null): string | null {
  const { flowByProject, statusById } = useOrgBase();
  const status = statusId ? statusById.get(statusId) : undefined;
  if (!status || status.category !== "backlog") return null;
  const resolved = projectId ? flowByProject.get(projectId) : undefined;
  const step = resolved && !flow?.paused ? locateStep(resolved, status, flow?.stepId) : null;
  return isParkedStatus(status, step, { paused: !resolved || !!flow?.paused }) ? status.name : null;
}

/** The task's bot assignee when it's assigned but parked (and not already working on it), else null. */
export function useParkedBot(task: Pick<Task, "projectId" | "statusId" | "flow" | "assigneeId" | "workingBotIds" | "archivedAt"> | null | undefined): { bot: Member; status: string } | null {
  const { memberById } = useOrgBase();
  const status = useParkedIn(task?.projectId, task?.statusId, task?.flow);
  const bot = task?.assigneeId ? memberById.get(task.assigneeId) : undefined;
  if (!task || !status || !bot || bot.kind !== "bot" || task.archivedAt || task.workingBotIds.includes(bot.id)) return null;
  return { bot, status };
}

/** "Hermes will start when this leaves Backlog." */
export const parkedHint = (botName: string, status: string) => `${botName} will start when this leaves ${status}.`;

/** Assignee picker footer on a parked task: what assigning a bot here does. */
export const parkedPickerNote = (status: string) => `Bots assigned here start when this leaves ${status}.`;

/** List row chip: the bot is assigned but parked, not working. Neutral, like Needs owner. */
export function ParkedChip({ bot, status, className }: { bot: Member; status: string; className?: string }) {
  const label = `${bot.name} is assigned but parked: ${parkedHint(bot.name, status)}`;
  return (
    <span
      title={label}
      aria-label={label}
      className={cn("inline-flex h-5 items-center gap-1 rounded-[5px] bg-chip px-1.5 text-[12px] whitespace-nowrap text-muted-foreground", className)}
    >
      <PauseIcon className="size-3.5" />
      Parked
    </span>
  );
}

/** Task pane note under the header: the bot is assigned but parked. */
export function ParkedNote({ bot, status, className }: { bot: Member; status: string; className?: string }) {
  return (
    <div role="status" className={cn("flex items-start gap-2 rounded-lg bg-sidebar px-3 py-2 text-[12.5px] text-muted-foreground", className)}>
      <PauseIcon className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground/80">{parkedHint(bot.name, status)}</span> It&apos;s assigned but parked in {status}, so nothing is
        handed over yet. Move it to a not-started or started status to hand it to {bot.name}.
      </span>
    </div>
  );
}
