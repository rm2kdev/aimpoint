"use client";

import { CheckIcon, PauseIcon, WorkflowIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOrgBase } from "@/components/org-provider";
import { MemberAvatar, UnassignedAvatar } from "@/components/bits";
import { locateStep, nextStepOf, stepIndex } from "@/lib/flow-engine-core";
import type { ResolvedFlow, ResolvedStep } from "@/lib/flow-model";
import { isClosedCategory, type Member, type Task } from "@/lib/types";

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

/** The task pane's compact stepper: completed steps, the current step and who has it, the next step and its owner. */
export function FlowStepper({ task, className }: { task: Pick<Task, "projectId" | "statusId" | "assigneeId" | "flow">; className?: string }) {
  const { memberById, statusById } = useOrgBase();
  const pos = useFlowPosition(task);
  if (!pos) return null;
  const assignee = task.assigneeId ? memberById.get(task.assigneeId) : undefined;

  if (pos.kind !== "at") {
    const status = statusById.get(task.statusId);
    // A cancelled (or closed, non-step) task has simply left its flow; saying so on every one is noise.
    if (pos.kind === "off" && isClosedCategory(status?.category)) return null;
    const statusName = status?.name ?? "its status";
    return (
      <section aria-label="Flow" className={cn("flex items-center gap-2 rounded-lg bg-sidebar px-3 py-2 text-[12.5px] text-muted-foreground", className)}>
        {pos.kind === "paused" ? <PauseIcon className="size-3.5 shrink-0" /> : <WorkflowIcon className="size-3.5 shrink-0" />}
        <span className="min-w-0 flex-1">
          {pos.kind === "paused"
            ? "Flow paused: it isn't handed on automatically. A split task waits here while its sub-tasks run."
            : `Off its flow: ${statusName} isn't one of the flow's steps, so nobody is handed it until it moves back into one.`}
        </span>
      </section>
    );
  }

  const { flow, index, current, next, finished } = pos;
  const label = finished ? `Flow finished at ${current.name}` : `Step ${index + 1} of ${flow.steps.length}: ${current.name}`;
  return (
    <section aria-label="Flow" className={cn("rounded-lg border border-border px-3 py-2.5 text-[12.5px]", className)}>
      <ol aria-label={label} className="flex flex-wrap items-center gap-x-1 gap-y-1">
        {flow.steps.map((s, i) => {
          const state = i < index || (finished && i === index) ? "done" : i === index ? "current" : "upcoming";
          return (
            <li key={s.id} className="flex min-w-0 items-center gap-1" aria-current={state === "current" ? "step" : undefined}>
              {i > 0 && <span aria-hidden className={cn("h-px w-2.5 shrink-0", i <= index ? "bg-muted-foreground/60" : "bg-border")} />}
              <span
                title={`${s.name} (${s.status.name})${state === "done" ? ", done" : state === "current" ? ", current step" : ""}`}
                className={cn(
                  "inline-flex h-5 max-w-[140px] items-center gap-1 rounded-[5px] px-1.5 whitespace-nowrap",
                  state === "current" ? "bg-foreground font-medium text-background" : state === "done" ? "bg-chip text-muted-foreground" : "text-faint",
                )}
              >
                {state === "done" ? (
                  <CheckIcon aria-hidden className="size-3 shrink-0" />
                ) : (
                  <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", state === "current" ? "bg-background" : "border border-faint")} />
                )}
                <span className="truncate">{s.name}</span>
                <span className="sr-only">{state === "done" ? " (done)" : state === "current" ? " (current)" : ""}</span>
              </span>
            </li>
          );
        })}
      </ol>
      {!finished && (
        <dl className="mt-2.5 grid grid-cols-[40px_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
          <dt className="text-faint">Now</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 font-medium">{current.name}</span>
            {current.advance === "wait" && current.wait?.label && <span className="shrink-0 text-muted-foreground">waiting: {current.wait.label}</span>}
            <span className="text-faint">·</span>
            <OwnerLine owner={assignee ? { member: assignee, id: assignee.id, label: assignee.name } : { label: "Unassigned" }} />
          </dd>
          {next && (
            <>
              <dt className="text-faint">Next</dt>
              <dd className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 font-medium">{next.name}</span>
                <span className="text-faint">·</span>
                {next.status.category === "done" ? (
                  <span className="truncate text-muted-foreground">closes the task</span>
                ) : (
                  <OwnerLine owner={stepOwner(next, assignee, memberById)} />
                )}
              </dd>
            </>
          )}
        </dl>
      )}
    </section>
  );
}

/**
 * The list row's step chip: the step name when it says more than the status already shown (two steps sharing
 * In Progress, a Develop step in Todo). Nothing on a finished, paused or off-flow task.
 */
export function FlowStepChip({ task, className }: { task: Pick<Task, "projectId" | "statusId" | "flow">; className?: string }) {
  const { statusById } = useOrgBase();
  const pos = useFlowPosition(task);
  if (!pos || pos.kind !== "at" || pos.finished) return null;
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
