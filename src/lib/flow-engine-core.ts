/**
 * Flow engine decisions (VEC-175, docs/flows.md section 5): pure and client-safe, no runtime imports, so the
 * server engine (lib/flow-engine.ts), the task UI and `node --test` share one set of rules. Everything here works
 * on a ResolvedFlow (lib/flow-model.ts) and hex ids; the server turns the answers into writes.
 */
import type { FlowStatusLike, ResolvedFlow, ResolvedStep } from "./flow-model";
import type { StatusCategory } from "./types";

/** How a write moved the task along its flow (stored as the flow_step activity note). */
export type FlowMoveNote = "advanced" | "back" | "synced" | "umbrella" | "paused" | "resumed";

export const stepIndex = (flow: ResolvedFlow, id: string | null | undefined) => (id ? flow.steps.findIndex((s) => s.id === id) : -1);
export const stepById = (flow: ResolvedFlow, id: string | null | undefined): ResolvedStep | null => flow.steps[stepIndex(flow, id)] ?? null;

const OPEN_PICKUP: readonly StatusCategory[] = ["backlog", "unstarted"];

/** The step names its owner (a bot or a person): the flow explicitly hands it to someone. */
export const namesOwner = (step: ResolvedStep | null | undefined) => !!step && (step.owner.kind === "bot" || step.owner.kind === "person");

/**
 * A task in a backlog-stage status is parked, not work (VEC-274): assigning a bot to it records the assignee only,
 * check_for_work doesn't hand it out and pickup never moves it out of Backlog. The one exception is a flow that
 * explicitly owns that step: the task's current step sits in this very status and names its owner (and no person
 * overrode that owner). `paused` = the task's flow is paused (or the project has none), so nothing owns it.
 */
export function isParkedStatus(status: Pick<FlowStatusLike, "id" | "category"> | null | undefined, step: ResolvedStep | null | undefined, opts: { paused?: boolean; ownerOverride?: boolean } = {}): boolean {
  if (status?.category !== "backlog") return false;
  if (opts.paused || opts.ownerOverride || !step) return true;
  return !(step.status.id === status.id && namesOwner(step));
}

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
 * The status a bot's pickup moves a step's task to (design 5.4): only from an unstarted-stage step or a backlog-stage
 * step that names its owner (VEC-274), to the
 * first started-stage status that no later step uses (so the work never lands on the tester's In Review). Null = pickup
 * leaves the status alone (the step already sits in a started status, such as In Review for the tester or Deploying
 * for CI, every started status belongs to a later step, or the project has no started status).
 */
export function workingStatus(flow: ResolvedFlow, step: ResolvedStep, statuses: readonly FlowStatusLike[]): FlowStatusLike | null {
  if (!OPEN_PICKUP.includes(step.status.category)) return null;
  // A Backlog step only starts when the flow explicitly owns it (VEC-274); otherwise the task stays parked.
  if (step.status.category === "backlog" && !namesOwner(step)) return null;
  const started = [...statuses].filter((s) => s.category === "started").sort((a, b) => a.order - b.order);
  const later = new Set(flow.steps.slice(stepIndex(flow, step.id) + 1).map((s) => s.status.id));
  // Every started status belongs to a later step (Todo > Research > Write): stay put. Moving it into the next step's
  // status while it's still at this step is how MAR-1 sat in Research before its Todo step was done (VEC-315).
  return started.find((s) => !later.has(s.id)) ?? null;
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

/**
 * The flow drives the work (VEC-315): some step past Triage names an owner or carries instructions. Unlike
 * flowIsActive (this step or the next), this looks at the whole pipeline, so a quiet step in the middle of an active
 * flow (Build > Review, both "its current assignee", before a bot's Test) still hands on. The seeded default, and a
 * flow whose only note is for its triage bots, don't drive anything.
 */
export function flowDrives(flow: ResolvedFlow): boolean {
  return flow.steps.some((s) => s.status.category !== "triage" && (namesOwner(s) || !!s.instructions.trim()));
}

/** The flow drives this step: complete_task hands it on, the owner is briefed and hand-offs are logged. */
export function stepDriven(flow: ResolvedFlow, step: ResolvedStep): boolean {
  return flowIsActive(flow, step) || (step.status.category !== "triage" && flowDrives(flow));
}

/**
 * complete_task WITH a status on a task at `current` (VEC-315). Models often pass the step's own status, a working
 * status (In Progress, In Review) or the next step's status when they mean "I'm done with my step": all of those
 * hand it on exactly as complete_task without a status does (`advance`). Everything else is taken as given
 * (`explicit`): an earlier step's status sends it back, a later step's status is a jump (the skip rules apply), a
 * done/cancelled status closes it, and a backlog/not-started status no step uses takes it out of the flow.
 * Wait steps, the done step and triage keep their own rules (explicit).
 */
export function finishWithStatus(flow: ResolvedFlow, current: ResolvedStep, requested: FlowStatusLike): "advance" | "explicit" {
  if (current.advance === "wait" || current.status.category === "done" || current.status.category === "triage") return "explicit";
  if (closed(requested.category) || requested.category === "triage") return "explicit";
  const next = nextStepOf(flow, current);
  if (!next) return "explicit";
  if (requested.id === current.status.id || requested.id === next.status.id) return "advance";
  if (!stepForStatus(flow, requested.id, current.id)) {
    // A status no step uses. A working status (started stage) of this step or a later one means "done with my step";
    // the working status of an earlier step (In Progress while at Test) is a send-back, as a person's drag is; a
    // backlog/not-started one leaves the flow.
    if (requested.category !== "started") return "explicit";
    const home = locateStep(flow, requested);
    return home && stepIndex(flow, home.id) < stepIndex(flow, current.id) ? "explicit" : "advance";
  }
  return "explicit";
}

/** Who a flow move hands the task to, if anyone (VEC-175 / VEC-315). */
export interface HandoffInput {
  flow: ResolvedFlow;
  /** The step it was at (null = it wasn't on the flow). */
  from: ResolvedStep | null;
  to: ResolvedStep;
  /** The assignee after the write (hex), null = nobody. */
  assignee: string | null;
  /** The write (or triage) chose the assignee, so the step's named owner doesn't apply. */
  ownerOverride: boolean;
  /** The assignee was set while the task was in Triage, not in this write. */
  assignedInTriage: boolean;
  /** Who is writing (hex) and whether it's a bot. */
  actor: string;
  actorIsBot: boolean;
}
/**
 * - `named`: the step names its bot/person, who gets it (an assignment, or a same-owner re-hand).
 * - `keep`: the step's owner is "its current assignee" on a flow that drives the work: that assignee is handed the
 *   new step (a bot is woken again; a person notified). Without this, a bot owning consecutive keep steps was told
 *   "you'll be handed it again" and never was: MAR-1 sat at Research (VEC-315).
 * - `triager`: the triage bot assigned the task to itself while triaging and now moves it out of Triage. Assigning
 *   itself mid-triage woke nobody (it was busy with it), so leaving Triage hands it over.
 * Null: nobody to hand to (unassigned, a done step, a pool step, a person's override, the seeded default).
 */
export function handoffKind(i: HandoffInput): "named" | "keep" | "triager" | null {
  if (!i.assignee || i.to.status.category === "done" || i.to.status.category === "triage") return null;
  if (i.from?.status.category === "triage") {
    return i.actorIsBot && i.assignedInTriage && i.assignee === i.actor && stepDriven(i.flow, i.to) ? "triager" : i.ownerOverride ? null : namesOwner(i.to) ? "named" : null;
  }
  if (i.ownerOverride) return null;
  if (namesOwner(i.to)) return "named";
  if (i.to.owner.kind === "keep" && !!i.from && i.from.id !== i.to.id && flowDrives(i.flow)) return "keep";
  return null;
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

/* ---------------- people's flow actions in the task pane (VEC-183, docs/flows.md 5.6 / 5.7) ---------------- */

/** Who is looking at the task, and who has it (ids hex). */
export interface FlowViewer {
  me: string;
  isAdmin: boolean;
  createdBy: string;
  assigneeId: string | null;
  /** The assignee is a person (not a bot). */
  assigneeIsPerson: boolean;
}

/**
 * The step action a person gets on a task's current step, or null:
 * - `wait`: a wait step, button labelled from `wait.label` ("Reply received"); moves it on like advance_task.
 *   For the step's owner (a person), the assignee, the creator or an admin.
 * - `complete`: "Complete step" on a step a person holds (the step names a person, or a person is assigned on an
 *   active flow, e.g. someone took over a bot's step); hands it to the next step. For that person, the assignee, the creator or an admin.
 * Bot-held steps have none: their bot finishes them with complete_task (people can still move the status).
 */
export type FlowStepAction = { kind: "wait" | "complete"; label: string; step: ResolvedStep; next: ResolvedStep };

export function flowStepAction(flow: ResolvedFlow, current: ResolvedStep, status: FlowStatusLike, v: FlowViewer): FlowStepAction | null {
  if (closed(status.category) || status.category === "triage" || current.status.category === "done") return null;
  const next = nextStepOf(flow, current);
  if (!next) return null;
  const ownerPerson = current.owner.kind === "person" && !!current.owner.id;
  const may = v.isAdmin || v.createdBy === v.me || v.assigneeId === v.me || (ownerPerson && current.owner.id === v.me);
  if (!may) return null;
  if (current.advance === "wait") return { kind: "wait", label: current.wait?.label?.trim() || "Mark as happened", step: current, next };
  const personHolds = ownerPerson || (v.assigneeIsPerson && flowIsActive(flow, current));
  return personHolds ? { kind: "complete", label: "Complete step", step: current, next } : null;
}

/** Pause / Resume flow (design 5.6): the task's creator, its assignee or an admin. */
export const canPauseFlow = (v: Pick<FlowViewer, "me" | "isAdmin" | "createdBy" | "assigneeId">) => v.isAdmin || v.createdBy === v.me || v.assigneeId === v.me;
