"use client";

import { useState, type ReactNode } from "react";
import { ArchiveIcon, CheckIcon, HourglassIcon, CirclePauseIcon, PauseIcon, PlayIcon, WorkflowIcon } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useOrgBase } from "@/components/org-provider";
import { MemberAvatar, UnassignedAvatar } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { canPauseFlow, flowStepAction, locateStep, nextStepOf, stalledMoveOn, stepIndex, type FlowStepAction } from "@/lib/flow-engine-core";
import type { ResolvedFlow, ResolvedStep } from "@/lib/flow-model";
import { statusTrack } from "@/lib/status-track";
import { StatusTrackBar } from "@/components/status-track-bar";
import { isClosedCategory, type Member, type Task } from "@/lib/types";
import { advanceTaskStep, moveStalledTaskOn, setTaskFlowPaused } from "@/app/actions/tasks";

/**
 * Where a task is in its project's flow (VEC-178, docs/flows.md section 7), for the task pane's stepper and the
 * list row's step chip. It uses the same rules as the engine (lib/flow-engine-core.ts): the recorded step when
 * it still exists, else located by status. Everything comes from the task (its `flow`, status and assignee,
 * all carried by task.upsert) and the org's flows (OrgProvider, refreshed on org.changed), so it follows a
 * hand-off live without a fetch.
 */
export type FlowPosition =
  | { kind: "paused"; flow: ResolvedFlow }
  /** Its status is none of the flow's steps (e.g. Cancelled): the flow doesn't apply right now. */
  | { kind: "off"; flow: ResolvedFlow }
  | { kind: "at"; flow: ResolvedFlow; current: ResolvedStep; index: number; next: ResolvedStep | null; finished: boolean };

export function useFlowPosition(task: Pick<Task, "projectId" | "statusId" | "flow">): FlowPosition | null {
  const { flowByProject, statusById } = useOrgBase();
  const flow = flowByProject.get(task.projectId);
  if (!flow) return null;
  if (task.flow?.paused) return { kind: "paused", flow };
  const status = statusById.get(task.statusId);
  const current = status ? locateStep(flow, status, task.flow?.stepId) : null;
  if (!current) return { kind: "off", flow };
  const finished = current.status.category === "done";
  return { kind: "at", flow, current, index: stepIndex(flow, current.id), next: finished ? null : nextStepOf(flow, current), finished };
}

/**
 * How long a task has sat at a wait step and on what (VEC-182, docs/flows.md 5.7): "6d" / "5h" / "12m" since it
 * entered the step (`task.flow.enteredAt`; null when it was never positioned), the step's "Waiting for" label (else
 * the step name), and whether it's past the step's "Remind after" days (when the one reminder goes out).
 */
export function waitState(step: ResolvedStep, task: Pick<Task, "flow">, now = Date.now()) {
  const label = step.wait?.label?.trim() || step.name;
  const days = step.wait?.remindAfterDays ?? null;
  const entered = task.flow?.stepId === step.id && task.flow.enteredAt ? Date.parse(task.flow.enteredAt) : NaN;
  if (Number.isNaN(entered)) return { label, waited: null, waitedLong: null, overdue: false, days };
  const ms = Math.max(0, now - entered);
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor(ms / 3_600_000);
  const waited = d >= 1 ? `${d}d` : h >= 1 ? `${h}h` : `${Math.max(1, Math.floor(ms / 60_000))}m`;
  const waitedLong = d >= 1 ? `${d} day${d === 1 ? "" : "s"}` : h >= 1 ? `${h} hour${h === 1 ? "" : "s"}` : "under an hour";
  return { label, waited, waitedLong, overdue: !!days && ms >= days * 86_400_000, days };
}

function waitTitle(step: ResolvedStep, w: ReturnType<typeof waitState>) {
  const reminder = w.days ? (w.overdue ? `, past the ${w.days}-day reminder` : `, reminder after ${w.days} day${w.days === 1 ? "" : "s"}`) : "";
  return `${w.waitedLong ? `Waiting ${w.waitedLong}` : "Waiting"} at ${step.name} for: ${w.label}${reminder}`;
}

/** "Waiting 6d: Reply received" on a row at a wait step; text turns full-strength once past the reminder. */
function WaitingChip({ step, task, className }: { step: ResolvedStep; task: Pick<Task, "flow">; className?: string }) {
  const w = waitState(step, task);
  const title = waitTitle(step, w);
  return (
    <span
      title={title}
      aria-label={title}
      data-waiting={w.overdue ? "overdue" : "waiting"}
      className={cn(
        "inline-flex h-5 max-w-[160px] min-w-0 items-center gap-1 rounded-[5px] bg-chip px-1.5 text-[12px] whitespace-nowrap",
        w.overdue ? "font-medium text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      <HourglassIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">
        {w.waited ? `Waiting ${w.waited}` : "Waiting"}: {w.label}
      </span>
    </span>
  );
}

type FlowTaskFields = Pick<Task, "id" | "key" | "projectId" | "statusId" | "assigneeId" | "createdBy" | "flow" | "archivedAt">;

/**
 * Pause / Resume flow for the task pane menu (VEC-183, docs/flows.md 5.6): offered to the creator, the assignee or
 * an admin on an open task whose project has a flow the UI shows. Paused, the flow ignores status and assignee
 * edits and complete_task; resuming re-syncs it by status without handing it to anyone.
 */
export function useFlowPause(task: FlowTaskFields | null, onTask?: (t: Task) => void) {
  const { org, me, isAdmin, flowByProject, statusById } = useOrgBase();
  const [busy, setBusy] = useState(false);
  const flow = task ? flowByProject.get(task.projectId) : undefined;
  const status = task ? statusById.get(task.statusId) : undefined;
  const paused = !!task?.flow?.paused;
  const can =
    !!task && !!flow && !task.archivedAt && (paused || !isClosedCategory(status?.category)) && canPauseFlow({ me: me.id, isAdmin, createdBy: task.createdBy, assigneeId: task.assigneeId });
  const toggle = async () => {
    if (!task || busy) return;
    setBusy(true);
    const r = await setTaskFlowPaused(org.slug, task.id, !paused);
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    if (r.data) onTask?.(r.data);
    toast.success(paused ? `Resumed the flow on ${task.key}` : `Paused the flow on ${task.key}`, {
      description: paused ? "It follows its flow again from the step of its status." : "Status and assignee changes won't hand it on until you resume it.",
    });
  };
  return { can, paused, busy, toggle };
}

/**
 * "Move to <next step>" for the pane's Stalled banner (VEC-317, docs/flows.md 5.8): a flow task whose bot finished
 * its step but that never moved on. Rules are the client-safe `stalledMoveOn` (creator or admin, a driven non-wait
 * step with a next step); the server re-checks them and moves it the way complete_task without a status does.
 * `why` names the step it's stuck at and where the flow should have sent it, for the banner text (`replaces`: instead
 * of the generic reason text, whose "move it to Done" a flow may refuse; otherwise appended to it).
 */
export function useStalledMoveOn(task: (FlowTaskFields & Pick<Task, "stalled">) | null, onTask?: (t: Task) => void) {
  const { org, me, isAdmin, statusById, memberById } = useOrgBase();
  const pos = useFlowPosition(task ?? { projectId: "", statusId: "", flow: null });
  const [busy, setBusy] = useState(false);
  const status = task ? statusById.get(task.statusId) : undefined;
  const move =
    task && !task.archivedAt && status && pos?.kind === "at" ? stalledMoveOn(pos.flow, pos.current, status, { me: me.id, isAdmin, createdBy: task.createdBy }, task.stalled?.reason) : null;
  if (!task || !move) return null;
  const next = move.next;
  const assignee = task.assigneeId ? memberById.get(task.assigneeId) : undefined;
  const nextOwner = next.status.category === "done" ? null : stepOwner(next, assignee, memberById).label;
  const to = `${next.name}${next.status.category === "done" ? ` (${next.status.name})` : ""}`;
  // "finished" today says "move it to Done", which a flow refuses past a required step: say where it's stuck instead.
  const stalled = task.stalled!;
  const n = stalled.blocking.length;
  const keys = n <= 1 ? stalled.blocking.join("") : `${stalled.blocking.slice(0, -1).join(", ")} and ${stalled.blocking[n - 1]}`;
  const bot = stalled.botId ? (memberById.get(stalled.botId)?.name ?? null) : null;
  const replaces = stalled.reason === "finished";
  const why = replaces
    ? `${bot ?? "Its bot"} finished its work, but the task is still at the ${move.step.name} step: the flow never handed it on to ${to}${n ? `, and ${keys} ${n === 1 ? "is" : "are"} waiting on it` : ""}. Move it on, or @mention ${bot ?? "the bot"} if the work isn't done.`
    : `It's still at the ${move.step.name} step: the flow never handed it on to ${to}.`;
  const run = async () => {
    if (busy) return;
    setBusy(true);
    const r = await moveStalledTaskOn(org.slug, task.id, move.step.id);
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    if (r.data) onTask?.(r.data);
    toast.success(`Moved ${task.key} to ${next.name}`, {
      description: next.status.category === "done" ? `Closed it (${next.status.name}).` : `${next.status.name}${nextOwner ? `, ${/^Stays|^Unassigned|^Any|^Nobody/.test(nextOwner) ? nextOwner.charAt(0).toLowerCase() + nextOwner.slice(1) : `handed to ${nextOwner}`}` : ""}.`,
    });
  };
  return { label: move.label, why, replaces, busy, run, title: `Hand it on to ${next.name}, the way the bot's complete_task would have` };
}

const sentence = (s: string) => s[0].toUpperCase() + s.slice(1);

/** The current step's person action (wait label / Complete step), with an optional note, for the stepper. */
function StepActionRow({ task, action, onTask }: { task: FlowTaskFields; action: FlowStepAction; onTask?: (t: Task) => void }) {
  const { org, memberById } = useOrgBase();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const next = action.next;
  const nextOwner = (next.owner.kind === "bot" || next.owner.kind === "person") && next.owner.id ? memberById.get(next.owner.id)?.name : undefined;
  const where = next.status.category === "done" ? `closes the task (${next.status.name})` : `moves it to ${next.name}${nextOwner ? ` for ${nextOwner}` : ""}`;
  const run = async () => {
    if (busy) return;
    setBusy(true);
    const r = await advanceTaskStep(org.slug, task.id, action.step.id, note.trim() || null);
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    if (r.data) onTask?.(r.data);
    setOpen(false);
    setNote("");
    const done = next.status.category === "done" ? `Closed it (${next.status.name})` : `Moved it to ${next.name}${nextOwner ? ` for ${nextOwner}` : ""}`;
    toast.success(`${action.kind === "wait" ? action.label : `Completed ${action.step.name}`} on ${task.key}`, { description: `${done}.` });
  };
  if (!open) {
    return (
      <div className="mt-2.5 flex items-center gap-2 border-t border-border pt-2.5">
        <Button size="sm" className="h-7 gap-1.5" onClick={() => setOpen(true)}>
          <CheckIcon className="size-3.5" /> {action.label}
        </Button>
        <span className="min-w-0 truncate text-muted-foreground">{sentence(where)}</span>
      </div>
    );
  }
  return (
    <form
      className="mt-2.5 grid gap-2 border-t border-border pt-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        void run();
      }}
    >
      <label htmlFor={`flow-note-${task.id}`} className="text-muted-foreground">
        {action.kind === "wait" ? "What happened? Optional, posted as a comment." : `A note for ${next.name}? Optional, posted as a comment.`}
      </label>
      <Textarea
        id={`flow-note-${task.id}`}
        autoFocus
        value={note}
        maxLength={10000}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void run();
          } else if (e.key === "Escape") {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        placeholder={action.kind === "wait" ? "e.g. Reply from J. Smith: wants a quote for 2 bathrooms" : "Anything the next step should know"}
        className="min-h-14 text-[13px] md:text-[13px]"
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" className="h-7" disabled={busy}>
          {action.label}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-7" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <span className="ml-auto min-w-0 truncate text-faint">{sentence(where)}</span>
      </div>
    </form>
  );
}

interface Owner {
  member?: Member;
  id?: string;
  label: string;
}

/** Who the next step goes to, by its owner rule ("keep" = whoever has it now). */
function stepOwner(step: ResolvedStep, assignee: Member | undefined, memberById: Map<string, Member>): Owner {
  const o = step.owner;
  if ((o.kind === "bot" || o.kind === "person") && o.id) {
    const m = memberById.get(o.id);
    return { member: m, id: o.id, label: m?.name ?? "a former member" };
  }
  if (o.removed) return { label: `Nobody (${o.removed.name} was removed)` };
  if (o.kind === "keep") return assignee ? { member: assignee, id: assignee.id, label: `Stays with ${assignee.name}` } : { label: "Stays unassigned" };
  if (o.kind === "triage") return { label: "Any triage bot" };
  return { label: "Unassigned, anyone can pick it up" };
}

function OwnerLine({ owner }: { owner: Owner }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {owner.id ? <MemberAvatar member={owner.member} id={owner.id} size={16} /> : <UnassignedAvatar size={14} />}
      <span className={cn("truncate", !owner.id && "text-muted-foreground")}>{owner.label}</span>
    </span>
  );
}

function PaneWaiting({ step, task }: { step: ResolvedStep; task: Pick<Task, "flow"> }) {
  const w = waitState(step, task);
  return (
    <>
      <dt className="text-faint">Waiting</dt>
      <dd title={waitTitle(step, w)} data-waiting={w.overdue ? "overdue" : "waiting"} className="flex min-w-0 items-center gap-1.5">
        <HourglassIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn("truncate", w.overdue && "font-medium")}>
          {w.waited ? `${w.waitedLong} for` : "For"} {w.label}
        </span>
        {w.days && (
          <span className="shrink-0 text-muted-foreground">
            · {w.overdue ? `past the ${w.days}d reminder` : `reminder after ${w.days}d`}
          </span>
        )}
      </dd>
    </>
  );
}

type BarTask = FlowTaskFields & Pick<Task, "waitingOn" | "stopped">;

/**
 * The task pane's status bar (VEC-329): the one component that draws where a task is, for every task. At a flow step
 * it's the flow stepper (completed steps, the current step and who has it, the next step and its owner, the step's
 * person action); otherwise (no flow, paused, off its flow, Cancelled) the project's own statuses with the current
 * one highlighted. Paused / off-flow / stopped / archived are a note under the bar, not a replacement for it.
 * Archived and stopped tasks are read-only here (no step action, no Resume). Steps come from `statusTrack`.
 */
export function TaskStatusBar({ task, className, onTask }: { task: BarTask; className?: string; onTask?: (t: Task) => void }) {
  const { memberById, statusById, statusesByProject, me, isAdmin } = useOrgBase();
  const pos = useFlowPosition(task);
  const pause = useFlowPause(task, onTask);
  const status = statusById.get(task.statusId);
  const track = statusTrack({
    statuses: statusesByProject.get(task.projectId) ?? [],
    statusId: task.statusId,
    flow: pos?.flow,
    stepIndex: pos?.kind === "at" ? pos.index : -1,
    paused: pos?.kind === "paused",
  });
  if (!track.steps.length) return null;
  const assignee = task.assigneeId ? memberById.get(task.assigneeId) : undefined;
  const readOnly = !!task.archivedAt || !!task.stopped;
  const at = track.source === "flow" && pos?.kind === "at" ? pos : null;
  const action =
    at && !at.finished && status && !readOnly
      ? flowStepAction(at.flow, at.current, status, { me: me.id, isAdmin, createdBy: task.createdBy, assigneeId: task.assigneeId, assigneeIsPerson: !!assignee && assignee.kind !== "bot" })
      : null;

  const notes: { key: string; icon: ReactNode; text: string; resume?: boolean }[] = [];
  if (track.reason === "paused")
    notes.push({
      key: "paused",
      icon: <PauseIcon className="size-3.5 shrink-0" />,
      text: task.waitingOn.length
        ? "Flow paused: it isn't handed on automatically. A split task waits here while its sub-tasks run."
        : "Flow paused: status and assignee changes don't hand it on until the flow is resumed.",
      resume: pause.can && !readOnly,
    });
  // A cancelled (or closed, non-step) task has simply left its flow; saying so on every one is noise.
  if (track.reason === "off_flow" && !isClosedCategory(status?.category))
    notes.push({
      key: "off",
      icon: <WorkflowIcon className="size-3.5 shrink-0" />,
      text: `Off its flow: ${status?.name ?? "its status"} isn't one of the flow's steps, so nobody is handed it until it moves back into one.`,
    });
  if (task.stopped && !task.archivedAt) notes.push({ key: "stopped", icon: <CirclePauseIcon className="size-3.5 shrink-0" />, text: "Work stopped: nothing is handed on until it's resumed." });
  if (task.archivedAt) notes.push({ key: "archived", icon: <ArchiveIcon className="size-3.5 shrink-0" />, text: "Archived: read-only until it's restored." });

  return (
    <StatusTrackBar track={track} className={className}>
      {at && !at.finished && (
        <dl className="mt-2.5 grid grid-cols-[52px_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
          <dt className="text-faint">Now</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-medium">{at.current.name}</span>
            <span className="text-faint">·</span>
            <OwnerLine owner={assignee ? { member: assignee, id: assignee.id, label: assignee.name } : { label: "Unassigned" }} />
          </dd>
          {at.current.advance === "wait" && <PaneWaiting step={at.current} task={task} />}
          {at.next && (
            <>
              <dt className="text-faint">Next</dt>
              <dd className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 font-medium">{at.next.name}</span>
                <span className="text-faint">·</span>
                {at.next.status.category === "done" ? (
                  <span className="truncate text-muted-foreground">closes the task</span>
                ) : (
                  <OwnerLine owner={stepOwner(at.next, assignee, memberById)} />
                )}
              </dd>
            </>
          )}
        </dl>
      )}
      {at && action && <StepActionRow key={`${at.current.id}:${task.statusId}`} task={task} action={action} onTask={onTask} />}
      {notes.map((n) => (
        <p key={n.key} data-track-note={n.key} className="mt-2 flex items-center gap-2 text-muted-foreground">
          {n.icon}
          <span className="min-w-0 flex-1">{n.text}</span>
          {n.resume && (
            <Button size="sm" variant="outline" className="-my-1 h-7 gap-1.5 bg-background" disabled={pause.busy} onClick={() => void pause.toggle()}>
              <PlayIcon className="size-3.5" /> Resume flow
            </Button>
          )}
        </p>
      ))}
    </StatusTrackBar>
  );
}

/**
 * The list row's step chip: the step name when it says more than the status already shown (two steps sharing
 * In Progress, a Develop step in Todo); at a wait step, how long it has waited and on what. Nothing on a
 * finished, paused or off-flow task.
 */
export function FlowStepChip({ task, className }: { task: Pick<Task, "projectId" | "statusId" | "flow">; className?: string }) {
  const { statusById } = useOrgBase();
  const pos = useFlowPosition(task);
  if (!pos || pos.kind !== "at" || pos.finished) return null;
  if (pos.current.advance === "wait") return <WaitingChip step={pos.current} task={task} className={className} />;
  const status = statusById.get(task.statusId);
  if (status && pos.current.name.trim().toLowerCase() === status.name.trim().toLowerCase()) return null;
  const label = `Flow step: ${pos.current.name} (step ${pos.index + 1} of ${pos.flow.steps.length})`;
  return (
    <span
      title={label}
      aria-label={label}
      className={cn("inline-flex h-5 max-w-[120px] items-center gap-1 rounded-[5px] bg-chip px-1.5 text-[12px] whitespace-nowrap text-muted-foreground", className)}
    >
      <WorkflowIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">{pos.current.name}</span>
    </span>
  );
}
