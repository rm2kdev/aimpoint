"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArchiveIcon, ArchiveRestoreIcon, ArrowRightIcon, CalendarIcon, ChevronDownIcon, CircleAlertIcon, CornerLeftUpIcon, CornerUpRightIcon, FilePlusIcon, HourglassIcon, ListPlusIcon, UnlinkIcon, LinkIcon, LockIcon, MoreHorizontalIcon, OctagonXIcon, PauseIcon, PlayIcon, PlusIcon, PowerOffIcon, RotateCcwIcon, Trash2Icon, UserRoundIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { taskAccess } from "@/lib/access";
import { useOrg, useOrgEvents } from "@/components/org-provider";
import { MemberAvatar, PriorityIcon, ProjectDot, TypeSquare, UnassignedAvatar } from "@/components/bits";
import { TaskStatusRing } from "@/components/task-status-ring";
import {
  Picker,
  PRIORITY_OPTIONS,
  TYPE_OPTIONS,
  useAssigneeOptions,
  useProjectOptions,
  useStatusOptions,
} from "@/components/pickers";
import { RichEditor } from "@/components/rich-editor";
import { CommentBody, MentionComposer } from "@/components/mentions";
import { useThreadGallery, type OpenGallery } from "@/components/thread-gallery";
import { galleryDescription } from "@/lib/comment-images";
import { DueBadge, DuePicker } from "@/components/due-date";
import { stalledText, TaskSearchPicker, toRef } from "@/components/dependencies";
import { useShell } from "@/components/app-shell";
import { msSince, QUIET_HINT_MS, useCanRetry, useRetryTask } from "@/components/retry-task";
import { TaskStatusBar, useFlowPause, useStalledMoveOn } from "@/components/task-flow";
import { StopConfirm, StoppedBanner, useStopWork, WorkingStrip } from "@/components/stop-work";
import { FormCreator, FormSubmitter, submitterLabel } from "@/components/task-source";
import { ParkedNote, parkedPickerNote, useParkedBot, useParkedIn } from "@/components/parked";
import { PlanSection, sameRichText, TextHistoryRow, type PlanFields } from "@/components/task-plan";
import { formatDay, formatDue, formatDueAbsolute } from "@/lib/dates";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { addComment, deleteTask, getTaskDetail, updateTask, type TaskPatch } from "@/app/actions/tasks";
import { PRIORITY_LABELS, timeAgo, TYPE_NAMES } from "@/lib/format";
import { disabledBotNote, heldMentionsToast, typedDisabledMentions } from "@/lib/bot-picker";
import { orgPath } from "@/lib/paths";
import { isClosedCategory, isStalledReason, type FeedItem, type Priority, type Stalled, type Task, type TaskDetail, type TaskRef, type TaskSource, type TaskType } from "@/lib/types";
import { TASK_TITLE_MAX } from "@/lib/task-intake-core";
import { PartOfLink, ProgressChip } from "@/components/subtasks";
import { AddExistingSubtaskDialog, ParentBlockedNote, parentBlockedReason, ParentPickerDialog, useSetParent } from "@/components/subtask-actions";
import { parentProgressText } from "@/lib/parent-progress-core";

const propBtn =
  "-ml-2 flex h-7 min-w-0 items-center gap-2 rounded-md px-2 text-[13px] transition-colors hover:bg-accent data-[state=open]:bg-accent disabled:cursor-default disabled:hover:bg-transparent";

export function TaskPane({ taskKey, onClose, onTask }: { taskKey: string; onClose: () => void; onTask: (t: Task) => void }) {
  const { org, me, isAdmin, statusById, memberById, members, projectById } = useOrg();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const pathname = usePathname();
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [error, setError] = useState<string>();
  const [deleted, setDeleted] = useState(false);
  const [descSync, setDescSync] = useState(0);
  const [planSync, setPlanSync] = useState(0);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const canRetry = useCanRetry(task);
  const retry = useRetryTask();
  // VEC-335: one lightbox over the thread's images (description, then comments oldest first).
  // VEC-370: the description part reads the editor's latest html (a local edit isn't echoed back to `task` by the broadcast).
  const editedDesc = useRef<string | null>(null);
  const gallery = useThreadGallery(() => galleryDescription(task?.description ?? "", editedDesc.current), feed);
  // The flow actions (VEC-183) answer with the moved task: update the list and this pane before the broadcast lands.
  const onFlowTask = (t: Task) => {
    onTask(t);
    setTask((cur) => (cur ? { ...cur, ...t } : cur));
  };
  const flowPause = useFlowPause(task, onFlowTask);
  // VEC-317: a flow task left at its step after its bot finished gets "Move to <next step>" in the Stalled banner.
  const moveOn = useStalledMoveOn(task, onFlowTask);
  // VEC-428: sub-task actions. Pickers open after the menu that launched them has closed.
  const setParent = useSetParent();
  const [pickParent, setPickParent] = useState(false);
  const [addExisting, setAddExisting] = useState(false);
  const later = (open: (v: boolean) => void) => () => window.setTimeout(() => open(true), 0);
  // VEC-217: Stop / Resume the bot's work (lib/stop-work.ts).
  const stopWork = useStopWork(task, onFlowTask);
  const [confirmStop, setConfirmStop] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const onRetry = async () => {
    if (!task || retrying) return;
    setRetrying(true);
    await retry(task);
    setRetrying(false);
  };

  const load = useCallback(async () => {
    const r = await getTaskDetail(org.slug, taskKey);
    if (!r.ok) return setError(r.error);
    setTask(r.data!.task);
    setFeed(r.data!.feed);
    editedDesc.current = null;
    setDescSync((n) => n + 1);
    setPlanSync((n) => n + 1);
  }, [org.slug, taskKey]);

  useEffect(() => {
    load();
  }, [load]);

  useOrgEvents((e) => {
    if (!task) return;
    if (e.type === "task.upsert" && e.task.id !== task.id) {
      // A dependency or dependent changed (status, title, key), or a task started or stopped depending on this one.
      const ref = toRef(e.task);
      const dependsOnMe = e.task.dependsOn.includes(task.id);
      setTask((t) => {
        if (!t) return t;
        const listed = t.dependents.some((d) => d.id === ref.id);
        // VEC-408: a sub-task of this one (new, changed, or moved to another parent).
        const mine = e.task.parentId === t.id;
        const sub = (t.subtasks ?? []).some((d) => d.id === ref.id);
        // Unrelated to this task: keep the same object, so the pane doesn't re-render for every edit in the org.
        if (!dependsOnMe && !listed && !t.dependencies.some((d) => d.id === ref.id) && !mine && !sub) return t;
        const dependents = dependsOnMe ? (listed ? t.dependents.map((d) => (d.id === ref.id ? ref : d)) : [...t.dependents, ref]) : t.dependents.filter((d) => d.id !== ref.id);
        const dependencies = t.dependencies.map((d) => (d.id === ref.id ? ref : d));
        const subtasks = mine ? (sub ? t.subtasks.map((d) => (d.id === ref.id ? ref : d)) : [...(t.subtasks ?? []), ref]) : (t.subtasks ?? []).filter((d) => d.id !== ref.id);
        return { ...t, dependents, dependencies, subtasks };
      });
    } else if (e.type === "task.upsert" && e.task.id === task.id) {
      setTask((t) => (t ? { ...t, ...e.task } : t));
      // Someone else changed what this waits on: fetch the refs for the new list.
      if (e.task.dependsOn.join() !== task.dependencies.map((d) => d.id).join()) {
        getTaskDetail(org.slug, e.task.key).then((r) => {
          if (r.ok) setTask((t) => (t ? { ...t, dependencies: r.data!.task.dependencies, dependents: r.data!.task.dependents } : t));
        });
      }
      if (e.descriptionChanged && e.actorId !== me.id) {
        getTaskDetail(org.slug, e.task.key).then((r) => {
          if (r.ok) {
            const d = r.data!.task;
            setTask((t) => (t ? { ...t, description: d.description, triagePlan: d.triagePlan, triagePlanBy: d.triagePlanBy, triagePlanAt: d.triagePlanAt } : t));
            editedDesc.current = null;
            setDescSync((n) => n + 1);
            setPlanSync((n) => n + 1);
          }
        });
      }
    } else if (e.type === "feed.add" && e.taskId === task.id) {
      setFeed((f) => (f.some((x) => x.id === e.item.id) ? f : [...f, e.item]));
    } else if (e.type === "task.delete" && e.taskId === task.id) {
      setDeleted(true);
    }
  });

  const patch = async (p: TaskPatch) => {
    if (!task) return;
    const before = task;
    setTask({ ...task, ...(p as Partial<TaskDetail>) });
    const r = await updateTask(org.slug, task.id, p);
    if (!r.ok) {
      setTask(before);
      toast.error(r.error);
      return;
    }
    if (r.data) {
      onTask(r.data);
      setTask((t) => (t ? { ...t, ...r.data } : t));
    }
  };

  /** Replace the dependency list (optimistic). */
  const setDependencies = async (refs: TaskRef[]) => {
    if (!task) return;
    const before = task;
    const dependsOn = refs.map((d) => d.id);
    setTask({ ...task, dependencies: refs, dependsOn });
    const r = await updateTask(org.slug, task.id, { dependsOn });
    if (!r.ok) {
      setTask(before);
      toast.error(r.error);
      return;
    }
    if (r.data) {
      onTask(r.data);
      setTask((t) => (t ? { ...t, ...r.data } : t));
    }
  };

  /* description autosave */
  const descTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingDesc = useRef<string | null>(null);
  const flushDesc = useCallback(async () => {
    clearTimeout(descTimer.current);
    if (pendingDesc.current === null || !task) return;
    const html = pendingDesc.current;
    pendingDesc.current = null;
    setSaveState("saving");
    const r = await updateTask(org.slug, task.id, { description: html });
    if (!r.ok) {
      toast.error(r.error);
      setSaveState("idle");
    } else {
      setSaveState("saved");
      // VEC-370: keep `task` in step with what was saved; the broadcast skips our own description edits.
      const id = task.id;
      setTask((t) => (t && t.id === id ? { ...t, description: html } : t));
    }
  }, [org.slug, task]);
  useEffect(() => () => void flushDesc(), [flushDesc]);

  /** VEC-404: the Plan card saved; take the server's copy of the plan fields. */
  const onPlanSaved = useCallback((fields: PlanFields) => setTask((t) => (t ? { ...t, ...fields } : t)), []);

  /** VEC-404: put back the text an activity entry kept (the description or plan before that change). */
  const restoreText = async (kind: "description" | "plan", html: string) => {
    if (!task) return;
    if (kind === "description") {
      clearTimeout(descTimer.current);
      pendingDesc.current = null;
    }
    const r = await updateTask(org.slug, task.id, kind === "description" ? { description: html } : { triagePlan: html });
    if (!r.ok) return void toast.error(r.error);
    if (r.data) onTask(r.data);
    const d = await getTaskDetail(org.slug, task.key);
    if (d.ok) {
      const t2 = d.data!.task;
      setTask((t) => (t ? { ...t, ...r.data, description: t2.description, triagePlan: t2.triagePlan, triagePlanBy: t2.triagePlanBy, triagePlanAt: t2.triagePlanAt } : t));
    }
    if (kind === "description") {
      editedDesc.current = null;
      setDescSync((n) => n + 1);
    } else setPlanSync((n) => n + 1);
    toast.success(kind === "description" ? "Restored the earlier description" : "Restored the earlier plan");
  };

  const setArchived = async (archived: boolean) => {
    if (!task) return;
    await patch({ archived });
    toast.success(`${archived ? "Archived" : "Restored"} ${task.key}`, {
      description: archived ? "Find it under Archive in the sidebar." : task.title,
    });
  };

  const statusOptions = useStatusOptions(task?.projectId);
  const assigneeOptions = useAssigneeOptions();
  const projectOptions = useProjectOptions(task?.projectId);
  const { newTask } = useShell();
  // VEC-276: a bot assigned to a Backlog task is parked, not working, until the task leaves Backlog.
  const parkedIn = useParkedIn(task?.projectId, task?.statusId, task?.flow);
  const parked = useParkedBot(task);

  const shell = (children: React.ReactNode) => (
    <aside
      aria-label="Task details"
      className="flex w-full min-w-0 flex-col border-l border-border bg-background lg:w-[440px] lg:shrink-0 xl:w-[500px] 2xl:w-[560px]"
    >
      {children}
    </aside>
  );

  if (error || deleted) {
    return shell(
      <>
        <PaneHeader taskKey={taskKey} onClose={onClose} />
        <div className="grid flex-1 place-items-center px-8 text-center">
          <div>
            <p className="text-[15px] font-semibold">{deleted ? "This task was deleted" : "Couldn't open this task"}</p>
            <p className="mt-1 text-[13.5px] text-muted-foreground">{deleted ? "Someone on your team removed it." : error}</p>
            <Button variant="outline" className="mt-5" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </>,
    );
  }

  if (!task) {
    return shell(
      <>
        <PaneHeader taskKey={taskKey} onClose={onClose} />
        <div className="space-y-3 px-6 py-6" aria-busy>
          <div className="h-6 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="mt-8 h-24 animate-pulse rounded bg-muted" />
        </div>
      </>,
    );
  }

  const status = statusById.get(task.statusId);
  const assignee = task.assigneeId ? memberById.get(task.assigneeId) : undefined;
  const project = projectById.get(task.projectId);
  const access = taskAccess(task, me.id, isAdmin);
  const canEdit = access === "full";
  const canWork = access !== "comment";
  const creator = memberById.get(task.createdBy);
  // A form-submitted task's creator is the form (VEC-208): only admins can edit it, so the notes name nobody else.
  const owner = task.source ? null : (creator?.name ?? "the creator");
  const closed = status?.category === "done" || status?.category === "cancelled";
  const waiting = task.dependencies.filter((d) => !isClosedCategory(statusById.get(d.statusId)?.category));
  const parentBlocked = parentBlockedReason(task);
  // One level only: a sub-task can't have sub-tasks, so only a top-level task offers "Add sub-task".
  const canAddSubtask = canEdit && !task.parentId && !task.archivedAt;

  return shell(
    <>
      <PaneHeader taskKey={task.key} onClose={onClose}>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Task actions" className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <MoreHorizontalIcon className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              className="gap-2.5"
              onSelect={() => {
                navigator.clipboard.writeText(`${location.origin}${location.pathname}?task=${task.key}`);
                toast.success(`Copied link to ${task.key}`);
              }}
            >
              <LinkIcon className="size-4" /> Copy link
            </DropdownMenuItem>
            {canRetry && (
              <DropdownMenuItem className="gap-2.5" disabled={retrying} onSelect={() => void onRetry()}>
                <RotateCcwIcon className="size-4" /> {waiting.length ? "Retry the chain" : "Retry hand-off"}
              </DropdownMenuItem>
            )}
            {stopWork.canStop && (
              <DropdownMenuItem className="gap-2.5" disabled={stopWork.busy} onSelect={() => setConfirmStop(true)}>
                <OctagonXIcon className="size-4" /> Stop {stopWork.working?.name ?? "the bot"}
              </DropdownMenuItem>
            )}
            {stopWork.canResume && (
              <DropdownMenuItem className="gap-2.5" disabled={stopWork.busy} onSelect={() => void stopWork.resume()}>
                <PlayIcon className="size-4" /> Resume work
              </DropdownMenuItem>
            )}
            {flowPause.can && !task.stopped && (
              <DropdownMenuItem className="gap-2.5" disabled={flowPause.busy} onSelect={() => void flowPause.toggle()}>
                {flowPause.paused ? <PlayIcon className="size-4" /> : <PauseIcon className="size-4" />} {flowPause.paused ? "Resume flow" : "Pause flow"}
              </DropdownMenuItem>
            )}
            {canEdit && !task.archivedAt && (
              <>
                <DropdownMenuSeparator />
                {task.parentKey ? (
                  <>
                    <DropdownMenuItem className="gap-2.5" onSelect={later(setPickParent)}>
                      <CornerUpRightIcon className="size-4" /> Move to another task…
                    </DropdownMenuItem>
                    <DropdownMenuItem className="gap-2.5" onSelect={() => void setParent(task, null).then((t) => t && onFlowTask(t))}>
                      <UnlinkIcon className="size-4" />
                      <span>
                        Remove from <span className="font-mono">{task.parentKey}</span>
                      </span>
                    </DropdownMenuItem>
                  </>
                ) : (
                  <>
                    <DropdownMenuItem className="gap-2.5" disabled={!!parentBlocked} onSelect={later(setPickParent)}>
                      <CornerLeftUpIcon className="size-4" /> Make sub-task of…
                    </DropdownMenuItem>
                    <ParentBlockedNote reason={parentBlocked} />
                  </>
                )}
                <DropdownMenuSeparator />
              </>
            )}
            {canEdit && (
              <>
                <DropdownMenuItem className="gap-2.5" onSelect={() => setArchived(!task.archivedAt)}>
                  {task.archivedAt ? <ArchiveRestoreIcon className="size-4" /> : <ArchiveIcon className="size-4" />}
                  {task.archivedAt ? "Restore" : "Archive"}
                  <span className="ml-auto font-mono text-[11.5px] text-faint">E</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" className="gap-2.5" onSelect={() => setConfirmDelete(true)}>
                  <Trash2Icon className="size-4" /> Delete task
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <StopConfirm ctl={stopWork} taskKey={task.key} open={confirmStop} onOpenChange={setConfirmStop} />
      </PaneHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-6 pt-5 pb-10">
          <div className="flex items-start gap-3">
            <Picker disabled={!canWork} label={`Status: ${status?.name}`} value={task.statusId} options={statusOptions} onChange={(statusId) => patch({ statusId })} searchable={false}>
              <button className="-m-1 mt-0.5 grid size-7 shrink-0 place-items-center rounded-full transition-transform enabled:hover:scale-110">
                <TaskStatusRing task={task} size={20} />
              </button>
            </Picker>
            <TitleField value={task.title} readOnly={!canEdit} onSave={(title) => patch({ title })} />
          </div>
          {task.parentKey && (
            <div className="mt-1 ml-8 flex items-center">
              <PartOfLink parentKey={task.parentKey} href={`${pathname}?task=${encodeURIComponent(task.parentKey)}`} className="-ml-1 h-6 text-[12.5px]" />
              {canEdit && !task.archivedAt && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`Change where ${task.key} belongs`}
                    data-part-of-menu=""
                    className="grid size-6 place-items-center rounded-[5px] text-faint outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent"
                  >
                    <ChevronDownIcon className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuItem className="gap-2.5" onSelect={later(setPickParent)}>
                      <CornerUpRightIcon className="size-4" /> Move to another task…
                    </DropdownMenuItem>
                    <DropdownMenuItem className="gap-2.5" onSelect={() => void setParent(task, null).then((t) => t && onFlowTask(t))}>
                      <UnlinkIcon className="size-4" />
                      <span>
                        Remove from <span className="font-mono">{task.parentKey}</span>
                      </span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </div>
          )}
          {task.archivedAt && (
            <div className="mt-3 flex items-center gap-2.5 rounded-lg bg-sidebar py-1.5 pr-1.5 pl-3 text-[12.5px] text-muted-foreground">
              <ArchiveIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                Archived{task.archivedBy ? ` by ${memberById.get(task.archivedBy)?.name ?? "a former member"}` : ""}{" "}
                <time dateTime={task.archivedAt} title={new Date(task.archivedAt).toLocaleString()}>
                  {timeAgo(task.archivedAt) === "now" ? "just now" : timeAgo(task.archivedAt)}
                </time>
              </span>
              {canEdit && (
                <Button size="sm" variant="outline" className="h-7 gap-1.5 bg-background" onClick={() => setArchived(false)}>
                  <ArchiveRestoreIcon className="size-3.5" /> Restore
                </Button>
              )}
            </div>
          )}
          {!task.archivedAt && <StoppedBanner task={task} ctl={stopWork} className="mt-3" />}
          {!task.archivedAt && <WorkingStrip ctl={stopWork} taskKey={task.key} className="mt-3" />}
          {task.stalled && isStalledReason(task.stalled.reason) && !closed && !task.archivedAt && (
            <div role="status" className={cn("mt-3 flex items-start gap-2 rounded-lg bg-destructive/10 py-2 pr-2 pl-3 text-[12.5px] text-destructive", moveOn && "flex-wrap pb-2.5")}>
              <CircleAlertIcon className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="font-medium">Stalled, needs attention.</span>{" "}
                {moveOn?.replaces ? moveOn.why : stalledText(task.stalled, task.stalled.botId ? (memberById.get(task.stalled.botId)?.name ?? null) : null)}
                {moveOn && !moveOn.replaces && ` ${moveOn.why}`}
              </span>
              {moveOn ? (
                // VEC-317: the one-click fix for a flow task left at its step, on its own row so the reason stays readable.
                <div className="flex basis-full items-center gap-2 pl-[22px]">
                  <Button size="sm" disabled={moveOn.busy} onClick={() => void moveOn.run()} title={moveOn.title} className="h-7 gap-1.5 px-2.5">
                    <ArrowRightIcon className="size-3.5" /> {moveOn.label}
                  </Button>
                  {canRetry && task.stalled.botId && <RetryButton busy={retrying} onClick={onRetry} className="border-destructive/30 bg-background text-destructive hover:text-destructive" />}
                </div>
              ) : (
                canRetry &&
                task.stalled.botId && <RetryButton busy={retrying} onClick={onRetry} className="-my-1 border-destructive/30 text-destructive hover:text-destructive" />
              )}
            </div>
          )}
          {parked && !task.stopped && <ParkedNote bot={parked.bot} status={parked.status} className="mt-3" />}
          {assignee?.kind === "bot" && assignee.disabled && !closed && !task.archivedAt && (
            // VEC-345: the assignee was switched off; the task stays with it but nothing wakes it.
            <p role="note" className="mt-3 flex items-start gap-2 rounded-lg bg-sidebar px-3 py-2 text-[12.5px] text-muted-foreground">
              <PowerOffIcon className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                {disabledBotNote(assignee.name)}{" "}
                <Link href={orgPath(org.slug, "settings", "bots", assignee.id)} className="underline underline-offset-2 hover:text-foreground">
                  Bot settings
                </Link>
              </span>
            </p>
          )}
          {canRetry && !closed && !task.archivedAt && !waiting.length && !(task.stalled && isStalledReason(task.stalled.reason)) && assignee?.kind === "bot" && !assignee.disabled && (
            <QuietHint botName={assignee.name} working={task.workingBotIds.includes(assignee.id)} since={lastPostBy(feed, assignee.id) ?? task.updatedAt} busy={retrying} onRetry={onRetry} />
          )}
          {waiting.length > 0 && !closed && !task.archivedAt && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-live-border bg-live py-2 pr-2 pl-3 text-[12.5px] text-foreground/80">
              <HourglassIcon className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                Waiting on {waiting.map((d) => d.key).join(", ")}.{" "}
                {assignee
                  ? assignee.id === me.id
                    ? "You'll be notified when it's ready to work on."
                    : assignee.kind === "bot"
                      ? `${assignee.name} gets it once ${waiting.length === 1 ? "that's" : "they're"} done.`
                      : `${assignee.name} will be notified when it's ready.`
                  : `Whoever it's assigned to hears about it once ${waiting.length === 1 ? "that's" : "they're"} done.`}
              </span>
              {canRetry && <RetryButton busy={retrying} onClick={onRetry} label="Retry chain" title={`Hand the open tasks at the front of ${task.key}'s chain to their bots again`} className="-my-1 bg-background" />}
            </div>
          )}
          {!canEdit && (
            <p className="mt-3 flex items-center gap-2 rounded-lg bg-sidebar px-3 py-2 text-[12.5px] text-muted-foreground">
              <LockIcon className="size-3.5 shrink-0" />
              {canWork
                ? `You're the assignee, so you can move it and change its details. Only ${owner ? `${owner} or an admin` : "an admin"} can edit the title and description.`
                : `Only ${owner ? `${owner}, the assignee` : "the assignee"} or an admin can change this task. You can still comment.`}
            </p>
          )}

          <TaskStatusBar task={task} className="mt-4" onTask={onFlowTask} />

          <dl className="mt-5 grid grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-[13px]">
            <dt className="text-faint">Status</dt>
            <dd>
              <Picker disabled={!canWork} label="Status" value={task.statusId} options={statusOptions} onChange={(statusId) => patch({ statusId })} searchable={false}>
                <button className={propBtn}>
                  <TaskStatusRing task={task} size={14} />
                  {status?.name ?? "No status"}
                </button>
              </Picker>
            </dd>
            <dt className="text-faint">Assignee</dt>
            <dd>
              <Picker
                disabled={!canWork}
                label="Assignee"
                value={task.assigneeId ?? "none"}
                options={assigneeOptions}
                onChange={(v) => patch({ assigneeId: v === "none" ? null : v })}
                placeholder="Assign to…"
                footer={parkedIn && parkedPickerNote(parkedIn)}
              >
                <button className={propBtn}>
                  {assignee ? <MemberAvatar member={assignee} id={assignee.id} size={18} /> : <UnassignedAvatar size={16} />}
                  <span className={cn("truncate", (!assignee || assignee.disabled) && "text-muted-foreground")} title={assignee?.disabled ? disabledBotNote(assignee.name) : undefined}>
                    {assignee?.name ?? "Unassigned"}
                  </span>
                  {assignee?.disabled && <span className="shrink-0 rounded-[4px] bg-chip px-1.5 py-px text-[11.5px] font-medium text-muted-foreground">disabled</span>}
                </button>
              </Picker>
            </dd>
            <dt className="text-faint">Priority</dt>
            <dd>
              <Picker disabled={!canWork} label="Priority" value={`${task.priority}`} options={PRIORITY_OPTIONS} onChange={(v) => patch({ priority: Number(v) as Priority })} searchable={false}>
                <button className={propBtn}>
                  <PriorityIcon priority={task.priority} />
                  <span className={cn(!task.priority && "text-muted-foreground")}>{PRIORITY_LABELS[task.priority]}</span>
                </button>
              </Picker>
            </dd>
            <dt className="text-faint">Type</dt>
            <dd>
              <Picker disabled={!canWork} label="Type" value={task.type} options={TYPE_OPTIONS} onChange={(type) => patch({ type })} searchable={false}>
                <button className={propBtn}>
                  <TypeSquare type={task.type} />
                  {TYPE_NAMES[task.type] ?? TYPE_NAMES.issue}
                </button>
              </Picker>
            </dd>
            <dt className="text-faint">Project</dt>
            <dd>
              <Picker disabled={!canEdit} label="Project" value={task.projectId} options={projectOptions} onChange={(projectId) => patch({ projectId })} placeholder="Move to project…">
                <button className={propBtn}>
                  {project && <ProjectDot color={project.color} />}
                  <span className="truncate">{project?.name}</span>
                </button>
              </Picker>
            </dd>
            <dt className="text-faint">Due date</dt>
            <dd>
              <DuePicker disabled={!canWork} value={task.dueDate} onChange={(dueDate) => patch({ dueDate })}>
                <button className={propBtn} aria-label={task.dueDate ? `Due ${formatDue(task.dueDate, true)}` : "Set due date"}>
                  {task.dueDate ? (
                    <DueBadge due={task.dueDate} long closed={status?.category === "done" || status?.category === "cancelled"} className="text-[13px]" />
                  ) : (
                    <>
                      <CalendarIcon className="size-3.5 text-faint" />
                      <span className="text-muted-foreground">{canWork ? "Set due date" : "None"}</span>
                    </>
                  )}
                </button>
              </DuePicker>
            </dd>
            <dt className="text-faint">Created</dt>
            <dd className="flex h-7 min-w-0 items-center gap-1.5 text-muted-foreground">
              <time dateTime={task.createdAt} title={new Date(task.createdAt).toLocaleString()}>
                {formatDay(task.createdAt)}
              </time>
              {task.source ? (
                <>
                  <span className="text-faint">via</span>
                  <FormCreator source={task.source} />
                </>
              ) : (
                creator && (
                  <>
                    <span className="text-faint">by</span>
                    <MemberAvatar member={creator} id={creator.id} size={16} />
                    <span className="truncate">{creator.name}</span>
                  </>
                )
              )}
            </dd>
            {task.source && (
              <>
                <dt className="text-faint">Submitted by</dt>
                <dd className="flex h-7 min-w-0 items-center text-muted-foreground">
                  <FormSubmitter source={task.source} />
                </dd>
              </>
            )}
            <dt className="text-faint">Updated</dt>
            <dd className="flex h-7 items-center text-muted-foreground">
              <time dateTime={task.updatedAt} title={new Date(task.updatedAt).toLocaleString()}>
                {timeAgo(task.updatedAt)}
              </time>
            </dd>
          </dl>

          <Subtasks
            task={task}
            canAdd={canAddSubtask}
            onNew={() => newTask({ projectId: task.projectId, parent: toRef(task) })}
            onAddExisting={later(setAddExisting)}
          />
          {pickParent && <ParentPickerDialog task={task} open={pickParent} onOpenChange={setPickParent} onSaved={onFlowTask} />}
          {addExisting && <AddExistingSubtaskDialog parent={task} open={addExisting} onOpenChange={setAddExisting} />}

          <Dependencies
            task={task}
            needsOwner={task.stalled?.reason === "needs_owner" && !closed && !task.archivedAt ? task.stalled : null}
            canEdit={canEdit}
            onChange={setDependencies}
            onNewDependent={() => newTask({ projectId: task.projectId, dependsOn: [toRef(task)] })}
          />

          <div className="mt-6 border-t border-border pt-5">
            {/* VEC-404: with a plan, the description is labelled as the reporter's original; untriaged tasks look as before. */}
            {task.triagePlan && <h3 className="mb-2 text-[12.5px] font-semibold">Original report</h3>}
            <RichEditor
              orgSlug={org.slug}
              editable={canEdit}
              placeholder={canEdit ? "Add a description…" : "No description"}
              value={task.description}
              syncKey={descSync}
              onExpandImage={(images, index, opener) => gallery.open({ from: "description", index, images }, opener)}
              onChange={(html) => {
                // VEC-404: an empty paragraph the editor appends by itself is no edit (it would save and log history).
                if (sameRichText(html, task.description)) {
                  clearTimeout(descTimer.current);
                  pendingDesc.current = null;
                  editedDesc.current = html;
                  return;
                }
                pendingDesc.current = html;
                editedDesc.current = html;
                setSaveState("idle");
                clearTimeout(descTimer.current);
                descTimer.current = setTimeout(flushDesc, 700);
              }}
            />
            <p className="mt-2 h-4 text-[11.5px] text-faint" aria-live="polite">
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}
            </p>
          </div>

          <PlanSection key={task.id} task={task} canEdit={canEdit} syncKey={planSync} onSaved={onPlanSaved} />

          <Feed feed={feed} source={task.source ?? null} onExpandImage={gallery.open} hasPlan={!!task.triagePlan} canRestore={canEdit} onRestore={restoreText} />
          <MentionComposer
            onSend={async (body) => {
              const r = await addComment(org.slug, task.id, body);
              if (!r.ok) {
                toast.error(r.error);
                return false;
              }
              const { heldMentions, ...item } = r.data!;
              setFeed((f) => (f.some((x) => x.id === item.id) ? f : [...f, item]));
              // VEC-353: picked mentions of a disabled bot come back as heldMentions; a name typed by hand is plain text, so find those here.
              const held = heldMentionsToast(heldMentions ?? [], typedDisabledMentions(body, members.filter((m) => m.kind === "bot")));
              if (held) toast(held.title, { description: held.description });
              return true;
            }}
          />
          {gallery.lightbox}
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {task.key}?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{task.title}&rdquo; and its comments will be removed for everyone. This can&rsquo;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep task</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const r = await deleteTask(org.slug, task.id);
                if (!r.ok) return void toast.error(r.error);
                toast.success(`Deleted ${task.key}`);
                onClose();
              }}
            >
              Delete task
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>,
  );
}

/** VEC-408: a parent's sub-tasks (the tasks filed from it), with the same rows as the dependencies. */
function Subtasks({ task, canAdd, onNew, onAddExisting }: { task: TaskDetail; canAdd: boolean; onNew: () => void; onAddExisting: () => void }) {
  const list = task.subtasks ?? [];
  if (!list.length && !canAdd) return null;
  return (
    <section className="mt-5 border-t border-border pt-4" aria-label="Sub-tasks">
      <div className="flex h-7 items-center gap-2">
        <h3 className="text-[12.5px] font-semibold">Sub-tasks</h3>
        {task.children && task.children.total > 0 && <ProgressChip summary={task.children} />}
        {canAdd && (
          // VEC-428: a new task filed under this one, or an existing task moved here.
          <DropdownMenu>
            <DropdownMenuTrigger
              data-add-subtask=""
              className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-accent"
            >
              <PlusIcon className="size-3.5" /> Add sub-task
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem className="gap-2.5" onSelect={() => window.setTimeout(onNew, 0)}>
                <FilePlusIcon className="size-4" /> New sub-task
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2.5" onSelect={onAddExisting}>
                <ListPlusIcon className="size-4" /> Add existing task…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {list.length ? (
        <ul className="mt-1 flex flex-col">
          {list.map((d) => (
            <RefRow key={d.id} refTask={d} />
          ))}
        </ul>
      ) : (
        <p className="py-1 text-[12.5px] text-faint">No sub-tasks yet. Break it down with a new task, or move an existing one here.</p>
      )}
    </section>
  );
}

/** "Depends on" (editable by the creator or an admin) and "Blocks" (read-only: edit it from the other task). */
function Dependencies({
  task,
  needsOwner,
  canEdit,
  onChange,
  onNewDependent,
}: {
  task: TaskDetail;
  /** Unassigned with waiters while still blocked itself (Stalled reason needs_owner): a neutral one-line hint. */
  needsOwner: Stalled | null;
  canEdit: boolean;
  onChange: (refs: TaskRef[]) => void;
  onNewDependent: () => void;
}) {
  const hasAny = task.dependencies.length > 0 || task.dependents.length > 0;
  if (!hasAny && !canEdit) return null;
  return (
    <section className="mt-5 border-t border-border pt-4" aria-label="Dependencies">
      <div className="flex h-7 items-center">
        <h3 className="text-[12.5px] font-semibold">Depends on</h3>
        {canEdit && (
          <TaskSearchPicker exclude={[task.id, ...task.dependencies.map((d) => d.id)]} onPick={(t) => onChange([...task.dependencies, toRef(t)])}>
            <button className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <PlusIcon className="size-3.5" /> Add
            </button>
          </TaskSearchPicker>
        )}
      </div>
      {task.dependencies.length ? (
        <ul className="mt-1 flex flex-col">
          {task.dependencies.map((d) => (
            <RefRow key={d.id} refTask={d} onRemove={canEdit ? () => onChange(task.dependencies.filter((x) => x.id !== d.id)) : undefined} />
          ))}
        </ul>
      ) : (
        <p className="py-1 text-[12.5px] text-faint">Nothing. It&rsquo;s ready to work on whenever.</p>
      )}

      {(task.dependents.length > 0 || canEdit) && (
        <>
          <div className="mt-3 flex h-7 items-center">
            <h3 className="text-[12.5px] font-semibold">Blocks</h3>
            <button
              onClick={onNewDependent}
              className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title="Create a task that starts once this one is done"
            >
              <PlusIcon className="size-3.5" /> Next task
            </button>
          </div>
          {task.dependents.length ? (
            <ul className="mt-1 flex flex-col">
              {task.dependents.map((d) => (
                <RefRow key={d.id} refTask={d} />
              ))}
            </ul>
          ) : (
            <p className="py-1 text-[12.5px] text-faint">No task waits for this one.</p>
          )}
          {needsOwner && (
            <p role="status" className="mt-2 flex items-start gap-2 rounded-lg bg-chip px-3 py-2 text-[12.5px] text-muted-foreground">
              <UserRoundIcon className="mt-px size-3.5 shrink-0" />
              <span>
                <span className="font-medium text-foreground/80">Needs an owner.</span> {stalledText(needsOwner, null)}
              </span>
            </p>
          )}
        </>
      )}
    </section>
  );
}

function RefRow({ refTask, onRemove }: { refTask: TaskRef; onRemove?: () => void }) {
  const { statusById, memberById } = useOrg();
  const status = statusById.get(refTask.statusId);
  const assignee = refTask.assigneeId ? memberById.get(refTask.assigneeId) : undefined;
  const done = status?.category === "done";
  const pathname = usePathname();
  return (
    <li className="group/ref -mx-2 flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] hover:bg-accent">
      <TaskStatusRing task={refTask} size={14} />
      <Link
        href={`${pathname}?task=${encodeURIComponent(refTask.key)}`}
        replace
        scroll={false}
        className={cn("min-w-0 flex-1 truncate", done && "text-faint line-through decoration-faint/50")}
        title={`${refTask.key} · ${status?.name ?? ""}`}
      >
        {refTask.title}
      </Link>
      {refTask.archived && <span className="shrink-0 rounded-[4px] bg-chip px-1.5 text-[11px] text-muted-foreground">Archived</span>}
      <span className="shrink-0 text-[12px] text-faint max-sm:hidden">{status?.name}</span>
      {assignee && <MemberAvatar member={assignee} id={assignee.id} size={16} />}
      <span className="tabular shrink-0 font-mono text-[11.5px] text-faint">{refTask.key}</span>
      {onRemove && (
        <button
          onClick={onRemove}
          aria-label={`Remove dependency on ${refTask.key}`}
          title="Remove dependency"
          className="-mr-1 grid size-6 shrink-0 place-items-center rounded text-faint opacity-0 transition-opacity group-hover/ref:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </li>
  );
}

function PaneHeader({ taskKey, onClose, children }: { taskKey: string; onClose: () => void; children?: React.ReactNode }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-4">
      <span className="tabular pl-2 font-mono text-[12px] text-faint">{taskKey}</span>
      <div className="ml-auto flex items-center gap-1">
        {children}
        <button
          onClick={onClose}
          aria-label="Close task (Esc)"
          title="Close (Esc)"
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}

function TitleField({ value, onSave, readOnly }: { value: string; onSave: (v: string) => void; readOnly?: boolean }) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(value);
  }, [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);
  const commit = () => {
    const t = draft.trim();
    if (!t) return setDraft(value);
    if (t !== value) onSave(t);
  };
  return (
    <textarea
      ref={ref}
      rows={1}
      value={draft}
      readOnly={readOnly}
      maxLength={TASK_TITLE_MAX}
      aria-label="Title"
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, " "))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
        if (e.key === "Escape") {
          setDraft(value);
          (e.target as HTMLTextAreaElement).blur();
        }
      }}
      data-zoom-safe
      className="min-w-0 flex-1 resize-none bg-transparent text-[20px] leading-[1.3] font-semibold tracking-[-0.02em] outline-none"
    />
  );
}

function Feed({
  feed,
  source,
  onExpandImage,
  hasPlan,
  canRestore,
  onRestore,
}: {
  feed: FeedItem[];
  source: TaskSource | null;
  onExpandImage: OpenGallery;
  hasPlan: boolean;
  canRestore: boolean;
  onRestore: (kind: "description" | "plan", html: string) => Promise<void>;
}) {
  const { memberById, statusById, projectById, me } = useOrg();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  if (!feed.length) return null;
  const lastPlanId = feed.findLast((f) => f.kind === "plan")?.id;
  const name = (id: string | null | undefined) => (id ? memberById.get(id)?.name ?? "a former member" : "nobody");

  /** A form submission's actor is the form id, which no member resolves: show who submitted it instead. */
  const actorName = (f: FeedItem, member: string | undefined) =>
    member ?? (f.kind === "created" && (f.note === "form" || f.note === "public") ? (source && submitterLabel(source)) || "Someone" : "Former member");
  const describe = (f: FeedItem) => {
    switch (f.kind) {
      case "created":
        // VEC-208: the actor is the form; the line names the submitter (see actorName) and the form.
        if (f.note === "form")
          return (
            <>
              submitted this via the <b className="font-medium text-foreground">{f.to ?? (source?.kind === "form" ? source.formName : null) ?? "external"}</b> form
            </>
          );
        if (f.note === "public") return "submitted this via the public project page";
        return "created this task";
      case "status":
        return (
          <>
            moved from <b className="font-medium text-foreground">{statusById.get(f.from ?? "")?.name ?? "a removed status"}</b> to{" "}
            <b className="font-medium text-foreground">{statusById.get(f.to ?? "")?.name ?? "a removed status"}</b>
            {f.note === "started_work"
              ? " (started work)"
              : f.note === "resumed_work"
                ? " (back to work after a mention)"
                : f.note === "stopped_work"
                  ? " (stopped the bot's work)"
                  : f.note === "subtask_started" || f.note === "subtask_done"
                    ? parentProgressText(f.note === "subtask_done" ? "done" : "started", f.subtask)
                    : null}
          </>
        );
      case "assignee":
        if (!f.to) return <>unassigned {name(f.from)}</>;
        if (f.note === "auto_owner") {
          // VEC-107: a bot parked its own task behind this unowned one, so Aimpoint made it the owner.
          const why = ` (nobody owned it and ${f.waiter ?? "a task assigned to it"} was waiting on it)`;
          return f.to === f.actorId ? `took this task${why}` : <>assigned this to <b className="font-medium text-foreground">{name(f.to)}</b>{why}</>;
        }
        if (f.to === f.actorId) return "took this task";
        return (
          <>
            assigned this to <b className="font-medium text-foreground">{name(f.to)}</b>
          </>
        );
      case "priority":
        return <>set priority to {PRIORITY_LABELS[Number(f.to) as Priority].toLowerCase()}</>;
      case "type":
        return <>changed the type to {(TYPE_NAMES[f.to as TaskType] ?? f.to ?? "issue").toLowerCase()}</>;
      case "title":
        return "renamed this task";
      case "due":
        return f.to ? (
          <>
            set the due date to <b className="font-medium text-foreground">{formatDueAbsolute(f.to)}</b>
          </>
        ) : (
          "cleared the due date"
        );
      case "archived":
        return "archived this task";
      case "restored":
        return "restored this task from the archive";
      case "project":
        return (
          <>
            moved this to <b className="font-medium text-foreground">{projectById.get(f.to ?? "")?.name ?? "another project"}</b>
          </>
        );
      case "dependency_added":
        return (
          <>
            made this depend on <b className="font-medium text-foreground">{f.to ?? "another task"}</b>
          </>
        );
      case "dependency_removed":
        return (
          <>
            removed the dependency on <b className="font-medium text-foreground">{f.to ?? "another task"}</b>
          </>
        );
      case "parent":
        // VEC-426: same wording as parentChangeText (lib/parent-link-core.ts), keys in bold.
        return f.to ? (
          <>
            made this a sub-task of <b className="font-medium text-foreground">{f.to}</b>
            {f.from ? <> (was under <b className="font-medium text-foreground">{f.from}</b>)</> : null}
          </>
        ) : (
          <>
            removed this from <b className="font-medium text-foreground">{f.from ?? "its parent task"}</b>
          </>
        );
      case "retried":
        return (
          <>
            asked <b className="font-medium text-foreground">{name(f.to)}</b> to {f.note === "closeout" ? "retry the close-out" : "retry this"}
          </>
        );
      case "stopped":
        return (
          <>
            stopped <b className="font-medium text-foreground">{name(f.to)}</b>
            {f.note === "triage" ? " triaging this" : "'s work on this"}
            {", so it's paused"}
          </>
        );
      case "resumed":
        return f.to ? (
          <>
            resumed this and handed it back to <b className="font-medium text-foreground">{name(f.to)}</b>
          </>
        ) : (
          "resumed this"
        );
      case "flow_step": {
        // VEC-175: the flow moved it to another step and handed it to that step's owner.
        const owner = f.flowOwner ? <b className="font-medium text-foreground">{name(f.flowOwner)}</b> : null;
        const where = <b className="font-medium text-foreground">{f.flowStatus ?? f.to}</b>;
        const steps = f.from ? ` (${f.from} \u2192 ${f.to})` : "";
        if (f.note === "umbrella") return <>split this into sub-tasks, so its flow is paused while they run</>;
        if (f.note === "paused") return <>paused its flow{f.from ? <> at <b className="font-medium text-foreground">{f.from}</b></> : null}</>;
        if (f.note === "resumed")
          return f.to ? (
            <>
              resumed its flow at the <b className="font-medium text-foreground">{f.to}</b> step
            </>
          ) : (
            <>resumed its flow (its status isn&apos;t one of the flow&apos;s steps)</>
          );
        if (f.note === "back" || f.note === "advanced") {
          return (
            <>
              {f.note === "back" ? "sent this back to " : "moved this to "}
              {where}
              {owner ? <> and handed it to {owner}</> : null} by flow{steps}
            </>
          );
        }
        return (
          <>
            put this at the <b className="font-medium text-foreground">{f.to}</b> step of its flow{owner ? <>, owned by {owner}</> : null}
          </>
        );
      }
      case "unblocked":
        return f.from ? (
          <>
            closed <b className="font-medium text-foreground">{f.from}</b>, so this is ready to work on
          </>
        ) : (
          "cleared what this was waiting on, so it's ready to work on"
        );
      default:
        return null;
    }
  };

  return (
    <section className="mt-6 border-t border-border pt-5" aria-label="Activity">
      <h3 className="mb-3 text-[12.5px] font-semibold">Activity</h3>
      <ol className="space-y-3">
        {feed.map((f) => {
          const actor = memberById.get(f.actorId);
          if (f.kind === "description" || f.kind === "plan")
            return (
              <TextHistoryRow
                key={f.id}
                item={f}
                actorName={actorName(f, actor?.name)}
                cleared={f.kind === "plan" && f.id === lastPlanId && !hasPlan}
                canRestore={canRestore}
                onRestore={onRestore}
              />
            );
          return f.kind === "comment" ? (
            <li key={f.id} className="flex gap-2.5">
              <MemberAvatar member={actor} id={f.actorId} size={22} className="mt-px" />
              <div className="min-w-0 flex-1">
                <div className="text-[13px]">
                  <span className="font-medium">{actor?.name ?? "Former member"}</span>
                  <time className="ml-2 text-[12px] text-faint" dateTime={f.createdAt} title={new Date(f.createdAt).toLocaleString()}>
                    {timeAgo(f.createdAt)}
                  </time>
                </div>
                <div
                  className={cn(
                    "mt-1 rounded-[10px] border border-border bg-sidebar px-3 py-2 text-[13.5px] leading-relaxed break-words whitespace-pre-wrap",
                    f.mentions?.includes(me.id) && "border-selected-foreground/25",
                  )}
                >
                  <CommentBody body={f.body ?? ""} onExpandImage={(index, opener) => onExpandImage({ from: "comment", id: f.id, index }, opener)} />
                </div>
              </div>
            </li>
          ) : (
            <li key={f.id} className="flex items-center gap-2.5 text-[13px] text-muted-foreground">
              <span className="grid w-[22px] place-items-center">
                <span className="size-1.5 rounded-full bg-input" />
              </span>
              <span className="min-w-0">
                <span className="font-medium text-foreground">{actorName(f, actor?.name)}</span> {describe(f)}
                <time className="ml-2 text-[12px] text-faint" dateTime={f.createdAt} title={new Date(f.createdAt).toLocaleString()}>
                  {timeAgo(f.createdAt)}
                </time>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * The latest comment or change by bot `id` in the feed, or the latest retry handed to it (VEC-159: how long a working
 * bot has been quiet; a fresh retry restarts the clock).
 */
function lastPostBy(feed: FeedItem[], id: string): string | null {
  for (let i = feed.length - 1; i >= 0; i--) {
    const f = feed[i];
    if (f.actorId === id || (f.kind === "retried" && f.to === id)) return f.createdAt;
  }
  return null;
}

function RetryButton({ busy, onClick, label = "Retry", title, className }: { busy: boolean; onClick: () => void; label?: string; title?: string; className?: string }) {
  return (
    <Button size="sm" variant="outline" disabled={busy} onClick={onClick} title={title ?? "Hand it to its bot again"} className={cn("h-7 shrink-0 gap-1.5 px-2.5", className)}>
      <RotateCcwIcon className={cn("size-3.5", busy && "animate-spin [animation-direction:reverse]")} /> {label}
    </Button>
  );
}

/**
 * VEC-159: a bot is on the task (or should be) but hasn't posted for QUIET_HINT_MS. Its run may have stopped without
 * failing, which nothing else detects, so offer a retry. Re-checked every minute.
 */
function QuietHint({ botName, working, since, busy, onRetry }: { botName: string; working: boolean; since: string; busy: boolean; onRetry: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  if (!working || msSince(since) < QUIET_HINT_MS) return null;
  return (
    <div role="status" className="mt-3 flex items-start gap-2 rounded-lg bg-sidebar py-2 pr-2 pl-3 text-[12.5px] text-muted-foreground">
      <HourglassIcon className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {botName} is on this but last posted <time dateTime={since} title={new Date(since).toLocaleString()}>{timeAgo(since)}</time>. If its run stopped, retry to hand it over again.
      </span>
      <RetryButton busy={busy} onClick={onRetry} className="-my-1 bg-background" />
    </div>
  );
}
