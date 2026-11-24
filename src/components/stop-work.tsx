"use client";

import { useState } from "react";
import { CirclePauseIcon, OctagonXIcon, PlayIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrgBase } from "@/components/org-provider";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { timeAgo } from "@/lib/format";
import { isClosedCategory, type Member, type ResumeOutcome, type Task } from "@/lib/types";
import { resumeTaskWork, stopTaskWork } from "@/app/actions/tasks";
import { emitTask, writeTask } from "@/lib/task-writes";

/**
 * Stop / Resume a bot's work from the task pane (VEC-217, server side in lib/stop-work.ts, VEC-215). Stop is offered
 * while a bot is working on the task (the working ring: an assignee's pick-up or a triage) to the task's creator, its
 * assignee, the bot's owner or an admin, the same people the server allows. A stopped task shows a banner with Resume.
 */

type StopFields = Pick<Task, "id" | "key" | "projectId" | "statusId" | "assigneeId" | "createdBy" | "archivedAt" | "workingBotIds" | "stopped">;

function mayStop(task: StopFields, bot: Member | undefined, me: string, isAdmin: boolean) {
  return isAdmin || task.createdBy === me || task.assigneeId === me || (!!bot?.ownerId && bot.ownerId === me);
}

export function useStopWork(task: StopFields | null, onTask?: (t: Task) => void) {
  const { org, me, isAdmin, memberById, statusById, statusesByProject, flowByProject } = useOrgBase();
  const [busy, setBusy] = useState(false);
  const cat = task ? statusById.get(task.statusId)?.category : undefined;
  // The bot whose work Stop would end: the assignee when it's on the ring, else the first working bot (a triager).
  const workingId = task && !task.stopped ? (task.assigneeId && task.workingBotIds.includes(task.assigneeId) ? task.assigneeId : task.workingBotIds[0]) : undefined;
  const working = workingId ? memberById.get(workingId) : undefined;
  const triaging = cat === "triage" && !!workingId && workingId !== task?.assigneeId;
  const canStop = !!task && !!working && working.kind === "bot" && !task.archivedAt && !isClosedCategory(cat) && mayStop(task, working, me.id, isAdmin);

  const stoppedBot = task?.stopped ? memberById.get(task.stopped.botId) : undefined;
  const assigneeBot = task?.assigneeId ? memberById.get(task.assigneeId) : undefined;
  const canResume =
    !!task?.stopped && !task.archivedAt && (mayStop(task, stoppedBot, me.id, isAdmin) || (assigneeBot?.kind === "bot" && mayStop(task, assigneeBot, me.id, isAdmin)));

  // VEC-456: both show at once (the strip goes, the Stopped banner shows) and go to the server in the background,
  // queued with the task's other writes; a refusal puts it back with the error toast.
  const stop = async () => {
    if (!task || busy || !workingId) return false;
    const statuses = statusesByProject.get(task.projectId) ?? [];
    const todo = statuses.find((s) => s.category === "unstarted");
    const moveBack = !triaging && cat === "started" && todo ? { statusId: todo.id } : {};
    const name = working?.name ?? "the bot";
    const shown = { ...task, stopped: task.stopped ?? null };
    writeTask<Task>({
      task: shown,
      label: `Stop ${name} on ${task.key}`,
      fields: {
        stopped: { by: me.id, at: new Date().toISOString(), botId: workingId, kind: triaging ? "triage" : "assigned" },
        workingBotIds: task.workingBotIds.filter((id) => id !== workingId),
        ...moveBack,
      },
      run: () => stopTaskWork(org.slug, task.id),
      onSaved: (t) => t && onTask?.(t),
    });
    toast.success(`Stopped ${name} on ${task.key}`, { description: "It's paused. Make your changes, then Resume to hand it back." });
    return true;
  };
  const resume = async () => {
    if (!task || busy) return;
    setBusy(true);
    const shown = { ...task, stopped: task.stopped ?? null };
    const { done } = writeTask<ResumeOutcome>({
      task: shown,
      label: `Resume ${task.key}`,
      fields: { stopped: null },
      run: () => resumeTaskWork(org.slug, task.id),
      echo: false,
      onSaved: (r) => {
        if (!r) return;
        emitTask(r.task);
        onTask?.(r.task);
      },
    });
    setBusy(false);
    const r = await done;
    if (!r.ok) return;
    const to = r.data?.task.assigneeId ? memberById.get(r.data.task.assigneeId) : stoppedBot;
    // VEC-352: its bot is disabled, so the stop is cleared but nothing goes out until it's enabled.
    if (r.data?.note) return void toast(`Resumed ${task.key}`, { description: r.data.note });
    toast.success(`Resumed ${task.key}`, {
      description: to?.kind === "bot" ? `Handed back to ${to.name}, who re-reads the task and comments first.` : "Its flow runs again.",
    });
  };
  const hasFlow = !!task && !!flowByProject.get(task.projectId);
  // Who Resume hands it to (VEC-219, mirrors resumeWorkAs): a triage stop goes back to its triager; an assigned stop to
  // the current assignee bot, which may not be the stopped bot after a reassignment; a person or nobody gets no hand-off.
  const resumeTo = !task?.stopped ? undefined : task.stopped.kind === "triage" ? stoppedBot : assigneeBot?.kind === "bot" ? assigneeBot : undefined;
  return { canStop, canResume, busy, working, triaging, hasFlow, stoppedBot, resumeTo, stop, resume };
}

/** Pane strip while a bot works on the task, with Stop (confirm first). */
export function WorkingStrip({ ctl, taskKey, className }: { ctl: ReturnType<typeof useStopWork>; taskKey: string; className?: string }) {
  const [confirm, setConfirm] = useState(false);
  if (!ctl.canStop || !ctl.working) return null;
  return (
    <>
      <div role="status" className={cn("flex items-center gap-2 rounded-lg bg-sidebar py-1.5 pr-1.5 pl-3 text-[12.5px] text-muted-foreground", className)}>
        <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-foreground/60 motion-reduce:animate-none" />
        <span className="min-w-0 flex-1">
          {ctl.working.name} is {ctl.triaging ? "triaging" : "working on"} this.
        </span>
        <Button size="sm" variant="outline" className="h-7 shrink-0 gap-1.5 bg-background px-2.5" disabled={ctl.busy} onClick={() => setConfirm(true)}>
          <OctagonXIcon className="size-3.5" /> Stop
        </Button>
      </div>
      <StopConfirm ctl={ctl} taskKey={taskKey} open={confirm} onOpenChange={setConfirm} />
    </>
  );
}

export function StopConfirm({ ctl, taskKey, open, onOpenChange }: { ctl: ReturnType<typeof useStopWork>; taskKey: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const name = ctl.working?.name ?? "the bot";
  const where = ctl.triaging ? "It stays in triage" : "It moves back to not started (it stays assigned)";
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Stop {name} on {taskKey}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {name} loses its hold on this task and gets no more hand-offs for it. {where}
            {ctl.hasFlow ? " with its flow paused" : ""}, so you can change it. Resume hands it back when you&apos;re ready.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep working</AlertDialogCancel>
          <AlertDialogAction
            disabled={ctl.busy}
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={async (e) => {
              e.preventDefault();
              if (await ctl.stop()) onOpenChange(false);
            }}
          >
            Stop {name}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Pane banner on a stopped task: who stopped it, and Resume for whoever may. */
export function StoppedBanner({ task, ctl, className }: { task: StopFields; ctl: ReturnType<typeof useStopWork>; className?: string }) {
  const { memberById, me } = useOrgBase();
  if (!task.stopped) return null;
  const by = task.stopped.by === me.id ? "you" : (memberById.get(task.stopped.by)?.name ?? "a former member");
  const bot = ctl.resumeTo?.name;
  const when = timeAgo(task.stopped.at);
  const note = ctl.canResume
    ? bot
      ? `Make your changes, then Resume to hand it back to ${bot}.`
      : "Make your changes, then Resume to clear the stop. Nobody is handed it: it's not assigned to a bot any more."
    : bot
      ? `${bot}'s work is on hold until it's resumed (by the task's creator, ${bot}'s owner or an admin).`
      : "It's on hold until it's resumed (by the task's creator, its assignee or an admin).";
  return (
    <div role="status" data-stopped className={cn("flex items-start gap-2 rounded-lg border border-border bg-sidebar py-2 pr-2 pl-3 text-[12.5px] text-foreground/80", className)}>
      <CirclePauseIcon className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground">
          Stopped by {by}, paused.
        </span>{" "}
        {note}{" "}
        <time className="text-faint" dateTime={task.stopped.at} title={new Date(task.stopped.at).toLocaleString()}>
          {when === "now" ? "just now" : when}
        </time>
      </span>
      {ctl.canResume && (
        <Button size="sm" variant="outline" className="-my-1 h-7 shrink-0 gap-1.5 bg-background px-2.5" disabled={ctl.busy} onClick={() => void ctl.resume()}>
          <PlayIcon className="size-3.5" /> Resume
        </Button>
      )}
    </div>
  );
}

/** Row chip for a stopped task. */
export function StoppedChip({ task, className }: { task: Pick<Task, "stopped">; className?: string }) {
  const { memberById } = useOrgBase();
  if (!task.stopped) return null;
  const label = `Stopped by ${memberById.get(task.stopped.by)?.name ?? "a former member"}: ${memberById.get(task.stopped.botId)?.name ?? "the bot"}'s work is paused until someone resumes it.`;
  return (
    <span
      title={label}
      aria-label={label}
      data-stopped-chip
      className={cn("inline-flex h-5 items-center gap-1 rounded-[5px] bg-chip px-1.5 text-[12px] whitespace-nowrap text-muted-foreground", className)}
    >
      <CirclePauseIcon className="size-3.5" />
      Stopped
    </span>
  );
}
