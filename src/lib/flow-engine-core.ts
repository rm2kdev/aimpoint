/**
 * Flow engine decisions (VEC-175, docs/flows.md section 5): pure and client-safe, no runtime imports, so the
 * server engine (lib/flow-engine.ts), the task UI and `node --test` share one set of rules. Everything here works
 * on a ResolvedFlow (lib/flow-model.ts) and hex ids; the server turns the answers into writes.
 */
import type { FlowStatusLike, ResolvedFlow, ResolvedStep } from "./flow-model";
import type { StatusCategory } from "./types";

/** How a write moved the task along its flow (stored as the flow_step activity note). */
export type FlowMoveNote = "advanced" | "back" | "synced" | "umbrella";

export const stepIndex = (flow: ResolvedFlow, id: string | null | undefined) => (id ? flow.steps.findIndex((s) => s.id === id) : -1);
export const stepById = (flow: ResolvedFlow, id: string | null | undefined): ResolvedStep | null => flow.steps[stepIndex(flow, id)] ?? null;

const OPEN_PICKUP: readonly StatusCategory[] = ["backlog", "unstarted"];
const closed = (c: StatusCategory) => c === "done" || c === "cancelled";

/**
 * The step a status belongs to: searched forward from `fromStepId` (so a status shared by several steps picks the
 * next one in the pipeline), then from the start. Null when no step uses that status.
 */
export function stepForStatus(flow: ResolvedFlow, statusId: string, fromStepId?: string | null): ResolvedStep | null {
  const from = Math.max(stepIndex(flow, fromStepId), 0);
  const order = [...flow.steps.slice(from), ...flow.steps.slice(0, from)];
  return order.find((s) => s.status.id === statusId) ?? null;
}

/**
 * The status a bot's pickup moves a step's task to (design 5.4): only from a backlog/unstarted-stage step, to the
 * first started-stage status that no later step uses (so the work never lands on the tester's In Review), else the
 * first started status. Null = pickup leaves the status alone (the step already sits in a started status, such as
 * In Review for the tester or Deploying for CI, or the project has no started status).
 */
export function workingStatus(flow: ResolvedFlow, step: ResolvedStep, statuses: readonly FlowStatusLike[]): FlowStatusLike | null {
  if (!OPEN_PICKUP.includes(step.status.category)) return null;
  const started = [...statuses].filter((s) => s.category === "started").sort((a, b) => a.order - b.order);
  const later = new Set(flow.steps.slice(stepIndex(flow, step.id) + 1).map((s) => s.status.id));
  return started.find((s) => !later.has(s.id)) ?? started[0] ?? null;
}

/**
 * Where a task is in its flow. Its recorded step when that still exists; otherwise (never positioned, detached, or
 * the flow changed under it) by its status: the step with that status, else (an open status no step uses, such as
 * In Progress, the working status of a Todo step) the last non-done step whose status comes before it in workflow
 * order. Null when nothing fits (e.g. a done or cancelled status that isn't a step).
 */
export function locateStep(flow: ResolvedFlow, status: FlowStatusLike, recorded?: string | null): ResolvedStep | null {
  const known = stepById(flow, recorded);
  if (known) return known;
  const exact = stepForStatus(flow, status.id);
  if (exact) return exact;
  if (closed(status.category) || status.category === "triage") return null;
  const before = flow.steps.filter((s) => s.status.category !== "done" && s.status.category !== "triage" && s.status.order <= status.order);
  return before[before.length - 1] ?? null;
}

/** The step after `step`: its jump target, else the next in order. Null after the last step. */
export function nextStepOf(flow: ResolvedFlow, step: ResolvedStep): ResolvedStep | null {
  if (step.next) {
    const jump = stepById(flow, step.next);
    if (jump) return jump;
  }
  return flow.steps[stepIndex(flow, step.id) + 1] ?? null;
}

/** Required steps strictly between `from` and a later `to` (a move that would skip them). Empty for back moves. */
export function requiredBetween(flow: ResolvedFlow, from: ResolvedStep, to: ResolvedStep): ResolvedStep[] {
  const a = stepIndex(flow, from.id);
  const b = stepIndex(flow, to.id);
  if (a < 0 || b <= a + 1) return [];
  return flow.steps.slice(a + 1, b).filter((s) => s.required);
}

/**
 * Who a step hands the task to. `set` = assign that id (null = unassign, a pool step); `keep` = leave the assignee.
 * "keep" and "any triage bot" owners keep it; so does the done step whatever its owner says, because closing a task
 * never unassigns whoever did it (behaviour-preserving for the seeded default flow).
 */
export function ownerPlan(step: ResolvedStep): { kind: "set"; id: string | null } | { kind: "keep" } {
  if (step.status.category === "done") return { kind: "keep" };
  if (step.owner.kind === "bot" || step.owner.kind === "person") return { kind: "set", id: step.owner.id ?? null };
  if (step.owner.kind === "none") return { kind: "set", id: null };
  return { kind: "keep" };
}

export const moveNote = (flow: ResolvedFlow, from: ResolvedStep | null, to: ResolvedStep): FlowMoveNote => {
  if (!from) return "synced";
  return stepIndex(flow, to.id) < stepIndex(flow, from.id) ? "back" : "advanced";
};

/**
 * Whether the hand-off text should talk about the flow at all: the step (or the one after it) names a real owner or
 * carries instructions. The seeded default (keep/triage owners, no instructions) stays silent, so bots on it keep
 * finishing with Done exactly as before.
 */
export function flowIsActive(flow: ResolvedFlow, step: ResolvedStep): boolean {
  const named = (s: ResolvedStep | null) => !!s && (s.owner.kind === "bot" || s.owner.kind === "person" || !!s.instructions.trim());
  return named(step) || named(nextStepOf(flow, step));
}

/** What a status-changing write does to the task's flow position (the pure half of planFlowForUpdate). */
export interface SyncInput {
  flow: ResolvedFlow;
  /** Where the task was (already located). */
  current: ResolvedStep | null;
  /** The task's new status. */
  status: FlowStatusLike;
}
export type SyncResult =
  /** Moved within its step (e.g. Todo -> In Progress, the step's working status): no change. */
  | { kind: "stay" }
  /** No step uses that status: the task leaves the flow until a later status change re-attaches it. */
  | { kind: "detach" }
  | { kind: "step"; step: ResolvedStep };

export function syncByStatus({ flow, current, status }: SyncInput): SyncResult {
  const hit = stepForStatus(flow, status.id, current?.id) ?? locateStep(flow, status);
  if (!hit) return { kind: "detach" };
  // An open status no step uses (In Progress) belongs to the step before it: the same step = moved within it.
  return hit.id === current?.id ? { kind: "stay" } : { kind: "step", step: hit };
}
