/**
 * Project flows (VEC-173 design, docs/flows.md; storage + resolution VEC-174): pure, client-safe model.
 * No runtime imports, so the editor UI, the server and `node --test` (type stripping) can all load it.
 * Ids are hex strings here; lib/flows.ts converts to and from the ObjectIds stored in Mongo.
 */
import type { StatusCategory } from "./types";

export type StepOwnerKind = "bot" | "person" | "triage" | "keep" | "none";
export type FlowAdvance = "complete" | "wait" | "manual";
/** A project's choice: follow the org default (absent = inherit), its own flow, or no flow at all. */
export type FlowMode = "inherit" | "custom" | "off";
export type FlowSource = "project" | "org";

export const FLOW_MODES: readonly FlowMode[] = ["inherit", "custom", "off"];
export const FLOW_ADVANCES: readonly FlowAdvance[] = ["complete", "wait", "manual"];
export const STEP_OWNER_KINDS: readonly StepOwnerKind[] = ["bot", "person", "triage", "keep", "none"];
const STAGES: readonly StatusCategory[] = ["backlog", "triage", "unstarted", "started", "done", "cancelled"];

export const FLOW_MAX_STEPS = 20;
export const FLOW_NAME_MAX = 60;
export const FLOW_STATUS_NAME_MAX = 40;
export const FLOW_INSTRUCTIONS_MAX = 4000;
export const FLOW_WAIT_LABEL_MAX = 60;
export const FLOW_REMIND_MAX_DAYS = 365;

export const isFlowMode = (v: unknown): v is FlowMode => typeof v === "string" && (FLOW_MODES as readonly string[]).includes(v);

/**
 * Where a task sits during a step. Org default steps name a stage plus an optional preferred status name;
 * project steps name an exact status (statusId) and keep its stage (and name) as the fallback for when that
 * status is deleted. `deleted` marks a project step whose status was deleted (VEC-174 keeps the step on
 * its fallback and the editor flags it).
 */
export interface FlowStepStatus {
  statusId?: string | null;
  stage: StatusCategory;
  name?: string | null;
  deleted?: boolean;
}
export interface FlowStepOwner {
  kind: StepOwnerKind;
  /** Bot or user id for kind bot/person. */
  id?: string | null;
  /** Set when the bot or person this step pointed at was removed from the org: the step is unowned now. */
  removed?: { kind: "bot" | "person"; name: string } | null;
}
export interface FlowWait {
  label: string;
  /** Bots (besides the step owner) allowed to resolve the wait with advance_task. */
  resolvers?: string[];
  remindAfterDays?: number | null;
}
export interface FlowStep {
  /** Stable id; survives renames and reorders. */
  id: string;
  name: string;
  status: FlowStepStatus;
  owner: FlowStepOwner;
  /** Markdown shown to the owner in the hand-off. */
  instructions?: string;
  advance: FlowAdvance;
  wait?: FlowWait | null;
  /** Default true. A bot can't finish the task while a later required step remains. */
  required?: boolean;
  /** Optional jump instead of the next step in order. */
  next?: string | null;
}

/**
 * The seeded org default (design section 4). Behaviour-preserving: owners are "triage" / "keep", the review
 * step is optional, so an org that never edits it sees no change.
 */
export const DEFAULT_FLOW_STEPS: readonly FlowStep[] = [
  { id: "triage", name: "Triage", status: { stage: "triage", name: "Triage" }, owner: { kind: "triage" }, advance: "complete", required: true },
  { id: "build", name: "Build", status: { stage: "unstarted", name: "Todo" }, owner: { kind: "keep" }, advance: "complete", required: true },
  { id: "review", name: "Review", status: { stage: "started", name: "In Review" }, owner: { kind: "keep" }, advance: "complete", required: false },
  { id: "done", name: "Done", status: { stage: "done", name: "Done" }, owner: { kind: "none" }, advance: "complete", required: true },
];
export const defaultFlowSteps = (): FlowStep[] => structuredClone(DEFAULT_FLOW_STEPS) as FlowStep[];

/* ---------------- resolution ---------------- */

export interface FlowStatusLike {
  id: string;
  name: string;
  category: StatusCategory;
  order: number;
}
/** Who can own steps in the org right now. Names are used in issue texts only. */
export interface FlowDirectory {
  bots: ReadonlyMap<string, string>;
  people: ReadonlyMap<string, string>;
}

export type FlowIssueCode =
  | "status_deleted" // project step's status is gone: resolved by stage/name instead
  | "stage_missing" // project has no status of the step's stage: step skipped
  | "stage_cancelled" // step resolved to a cancelled status: step skipped (cancelling always leaves the flow)
  | "owner_removed" // bot/person removed: step unowned
  | "owner_invalid" // triage owner on a non-triage step: treated as keep
  | "resolver_removed" // a wait resolver bot is gone: dropped
  | "next_missing"; // jump target missing or skipped: falls through to the next step in order

export interface FlowIssue {
  code: FlowIssueCode;
  message: string;
}
export interface ResolvedStep {
  id: string;
  name: string;
  status: FlowStatusLike;
  owner: FlowStepOwner;
  instructions: string;
  advance: FlowAdvance;
  wait: FlowWait | null;
  required: boolean;
  next: string | null;
  issues: FlowIssue[];
}
export interface SkippedStep {
  id: string;
  name: string;
  issues: FlowIssue[];
}
export interface ResolvedFlow {
  source: FlowSource;
  version: number;
  /** Steps that apply in this project, in pipeline order. */
  steps: ResolvedStep[];
  /** Steps that don't apply in this project (stage missing / cancelled), with why. */
  skipped: SkippedStep[];
  /** True when any step was adjusted or skipped (the editor shows a warning). */
  hasIssues: boolean;
}

const sortByOrder = <S extends FlowStatusLike>(list: readonly S[]) => [...list].sort((a, b) => a.order - b.order);

/** The project status a step points at: exact id, else stage + preferred name, else the stage's first status. */
export function resolveStepStatus(
  ref: FlowStepStatus,
  statuses: readonly FlowStatusLike[],
): { status: FlowStatusLike | null; issue: FlowIssue | null } {
  const sorted = sortByOrder(statuses);
  let issue: FlowIssue | null = null;
  if (ref.statusId) {
    const hit = sorted.find((s) => s.id === ref.statusId);
    if (hit) return { status: hit, issue: null };
    issue = { code: "status_deleted", message: `Its status${ref.name ? ` ${ref.name}` : ""} was deleted` };
  } else if (ref.deleted) {
    issue = { code: "status_deleted", message: `Its status${ref.name ? ` ${ref.name}` : ""} was deleted` };
  }
  const name = ref.name?.trim().toLowerCase();
  const byStage = sorted.filter((s) => s.category === ref.stage);
  const status = (name ? byStage.find((s) => s.name.toLowerCase() === name) : undefined) ?? byStage[0] ?? null;
  if (issue && status) issue = { ...issue, message: `${issue.message}; using ${status.name}` };
  return { status, issue };
}

/**
 * Maps stored steps onto one project's statuses and the org's current bots/people. Never throws: bad
 * references are dropped or flagged (issues), steps whose stage the project lacks are skipped.
 */
export function resolveFlowSteps(
  steps: readonly FlowStep[],
  statuses: readonly FlowStatusLike[],
  dir: FlowDirectory,
  meta: { source: FlowSource; version: number },
): ResolvedFlow {
  const out: ResolvedStep[] = [];
  const skipped: SkippedStep[] = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step.id !== "string") continue;
    const name = typeof step.name === "string" && step.name.trim() ? step.name.trim() : "Step";
    const issues: FlowIssue[] = [];
    const ref: FlowStepStatus = step.status && STAGES.includes(step.status.stage) ? step.status : { stage: "unstarted" };
    const { status, issue } = resolveStepStatus(ref, statuses);
    if (issue) issues.push(issue);
    if (!status) {
      issues.push({ code: "stage_missing", message: `This project has no ${ref.stage} status, so the step is skipped` });
      skipped.push({ id: step.id, name, issues });
      continue;
    }
    if (status.category === "cancelled") {
      issues.push({ code: "stage_cancelled", message: `${status.name} is a cancelled status, so the step is skipped` });
      skipped.push({ id: step.id, name, issues });
      continue;
    }
    out.push({
      id: step.id,
      name,
      status,
      owner: resolveOwner(step.owner, status.category, dir, issues),
      instructions: typeof step.instructions === "string" ? step.instructions : "",
      advance: FLOW_ADVANCES.includes(step.advance) ? step.advance : "complete",
      wait: step.advance === "wait" ? resolveWait(step.wait, dir, issues) : null,
      required: step.required !== false,
      next: typeof step.next === "string" && step.next ? step.next : null,
      issues,
    });
  }
  // Steps after a done step can't be reached; a jump into a skipped/missing step falls through.
  const firstDone = out.findIndex((s) => s.status.category === "done");
  if (firstDone >= 0) {
    for (const s of out.splice(firstDone + 1)) {
      skipped.push({ id: s.id, name: s.name, issues: [...s.issues, { code: "stage_missing", message: "It comes after the done step, so it never runs" }] });
    }
  }
  const ids = new Set(out.map((s) => s.id));
  for (const s of out) {
    if (s.status.category === "done" && s.next) s.next = null;
    if (s.next && (!ids.has(s.next) || s.next === s.id)) {
      s.issues.push({ code: "next_missing", message: "Its jump target no longer applies; it goes to the next step in order" });
      s.next = null;
    }
  }
  return {
    source: meta.source,
    version: meta.version,
    steps: out,
    skipped,
    hasIssues: skipped.length > 0 || out.some((s) => s.issues.length > 0),
  };
}

function resolveOwner(owner: FlowStepOwner | undefined, stage: StatusCategory, dir: FlowDirectory, issues: FlowIssue[]): FlowStepOwner {
  const kind = owner && STEP_OWNER_KINDS.includes(owner.kind) ? owner.kind : "none";
  if (owner?.removed && kind === "none") {
    issues.push({ code: "owner_removed", message: `${owner.removed.name} was removed, so nobody owns this step` });
    return { kind: "none" };
  }
  if (kind === "bot" || kind === "person") {
    const book = kind === "bot" ? dir.bots : dir.people;
    if (owner?.id && book.has(owner.id)) return { kind, id: owner.id };
    issues.push({ code: "owner_removed", message: `Its ${kind === "bot" ? "bot" : "owner"} is no longer in the organisation, so nobody owns this step` });
    return { kind: "none" };
  }
  if (kind === "triage" && stage !== "triage") {
    issues.push({ code: "owner_invalid", message: "Any triage bot only applies to a triage status; the assignee is kept" });
    return { kind: "keep" };
  }
  return { kind };
}

function resolveWait(wait: FlowWait | null | undefined, dir: FlowDirectory, issues: FlowIssue[]): FlowWait {
  const resolvers = Array.isArray(wait?.resolvers) ? wait!.resolvers : [];
  const kept = resolvers.filter((id) => dir.bots.has(id));
  if (kept.length < resolvers.length) issues.push({ code: "resolver_removed", message: "A bot that could resolve the wait was removed" });
  const days = wait?.remindAfterDays;
  return {
    label: typeof wait?.label === "string" && wait.label.trim() ? wait.label.trim() : "Waiting",
    resolvers: kept,
    remindAfterDays: Number.isInteger(days) && days! > 0 ? days! : null,
  };
}

/**
 * The org default copied onto a project ("Customise for this project"): each step pinned to the exact
 * status it resolves to there. Steps the project can't place are left out.
 */
export function pinStepsToProject(resolved: ResolvedFlow): FlowStep[] {
  return resolved.steps.map((s) => ({
    id: s.id,
    name: s.name,
    status: { statusId: s.status.id, stage: s.status.category, name: s.status.name },
    owner: s.owner.kind === "bot" || s.owner.kind === "person" ? { kind: s.owner.kind, id: s.owner.id } : { kind: s.owner.kind },
    ...(s.instructions ? { instructions: s.instructions } : {}),
    advance: s.advance,
    ...(s.wait ? { wait: s.wait } : {}),
    required: s.required,
    next: s.next,
  }));
}

/* ---------------- validation ---------------- */

export type FlowLevel = "org" | "project";
export interface FlowValidationContext {
  level: FlowLevel;
  /** Project level: the project's statuses (every statusId must be one of these). */
  statuses?: readonly FlowStatusLike[];
  dir: FlowDirectory;
  /** Makes an id for a step sent without one. */
  newId: () => string;
}
/**
 * `errors` = every message (each prefixed with its step's name), for a server UserError. `stepErrors[i]` =
 * step i's messages without the prefix and `flowErrors` = the flow-wide ones, so the editor can show them inline.
 */
export type FlowValidation =
  | { ok: true; steps: FlowStep[] }
  | { ok: false; errors: string[]; stepErrors: Record<number, string[]>; flowErrors: string[] };

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const str = (v: unknown) => (typeof v === "string" ? v : "");

/**
 * Checks and normalises steps sent by the editor (untrusted input). Rules (design 3.2): 1..20 steps, unique
 * ids, names 1..60, statuses valid for the level (project: the project's own statuses; never cancelled),
 * the last step is a done step and nothing follows a done step, owners are org bots/people, "any triage bot"
 * only on a triage step, wait settings only with advance "wait", `next` names another step, no two
 * consecutive identical steps (same status and owner).
 */
export function validateFlow(input: unknown, ctx: FlowValidationContext): FlowValidation {
  const errors: string[] = [];
  const stepErrors: Record<number, string[]> = {};
  const flowErrors: string[] = [];
  const flowErr = (m: string): FlowValidation => ({ ok: false, errors: [m], stepErrors, flowErrors: [m] });
  /** Records a step's message twice: prefixed for the server error, bare (capitalised) for the editor. */
  const stepErr = (i: number, label: string, m: string) => {
    errors.push(`${label}: ${m}`);
    const bare = m.charAt(0).toUpperCase() + m.slice(1);
    const list = (stepErrors[i] ??= []);
    if (!list.includes(bare)) list.push(bare);
  };
  if (!Array.isArray(input)) return flowErr("A flow is a list of steps.");
  if (input.length < 1) return flowErr("A flow needs at least one step (its last step is a done step).");
  if (input.length > FLOW_MAX_STEPS) return flowErr(`A flow has at most ${FLOW_MAX_STEPS} steps.`);
  const statuses = ctx.statuses ? sortByOrder(ctx.statuses) : null;
  if (ctx.level === "project" && !statuses) return flowErr("Project flows need the project's statuses.");

  const steps: FlowStep[] = [];
  const seen = new Set<string>();
  input.forEach((raw: unknown, i: number) => {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = str(r.name).trim();
    const label = name || `Step ${i + 1}`;
    const err = (m: string) => stepErr(i, label, m);
    let id = str(r.id).trim();
    if (!id) id = ctx.newId();
    if (!ID_RE.test(id)) err("has an invalid id.");
    else if (seen.has(id)) err("has the same id as another step.");
    seen.add(id);
    if (!name) {
      errors.push(`Step ${i + 1} needs a name.`);
      (stepErrors[i] ??= []).push("Needs a name.");
    }
    else if (name.length > FLOW_NAME_MAX) err(`names are up to ${FLOW_NAME_MAX} characters.`);

    // Status
    const rs = (r.status && typeof r.status === "object" ? r.status : {}) as Record<string, unknown>;
    let status: FlowStepStatus = { stage: "unstarted" };
    if (ctx.level === "project") {
      const sid = str(rs.statusId);
      const hit = statuses!.find((s) => s.id === sid);
      if (!hit) err("pick one of this project's statuses.");
      else if (hit.category === "cancelled") err(`${hit.name} is a cancelled status; cancelling always leaves the flow, so it can't be a step.`);
      else status = { statusId: hit.id, stage: hit.category, name: hit.name };
    } else {
      const stage = str(rs.stage) as StatusCategory;
      const sname = str(rs.name).trim();
      if (!STAGES.includes(stage)) err("pick a stage.");
      else if (stage === "cancelled") err("cancelled can't be a step; cancelling always leaves the flow.");
      if (sname.length > FLOW_STATUS_NAME_MAX) err(`status names are up to ${FLOW_STATUS_NAME_MAX} characters.`);
      status = { stage: STAGES.includes(stage) ? stage : "unstarted", ...(sname ? { name: sname } : {}) };
    }

    // Owner
    const ro = (r.owner && typeof r.owner === "object" ? r.owner : {}) as Record<string, unknown>;
    const kind = str(ro.kind) as StepOwnerKind;
    let owner: FlowStepOwner = { kind: "none" };
    if (!STEP_OWNER_KINDS.includes(kind)) err("pick an owner.");
    else if (kind === "bot" || kind === "person") {
      const oid = str(ro.id);
      const book = kind === "bot" ? ctx.dir.bots : ctx.dir.people;
      if (!book.has(oid)) err(kind === "bot" ? "its bot isn't one of this organisation's bots." : "its owner isn't a member of this organisation.");
      else owner = { kind, id: oid };
    } else {
      if (kind === "triage" && status.stage !== "triage") err("\"Any triage bot\" can only own a triage step.");
      owner = { kind };
    }

    // Instructions
    const instructions = typeof r.instructions === "string" ? r.instructions.replace(/\r\n?/g, "\n").trim() : "";
    if (r.instructions != null && typeof r.instructions !== "string") err("instructions must be text.");
    if (instructions.length > FLOW_INSTRUCTIONS_MAX) err(`instructions are up to ${FLOW_INSTRUCTIONS_MAX.toLocaleString("en")} characters.`);

    // Advance + wait
    const advance = (str(r.advance) || "complete") as FlowAdvance;
    if (!FLOW_ADVANCES.includes(advance)) err("pick how the step finishes (complete, wait or manual).");
    let wait: FlowWait | null = null;
    if (advance === "wait") {
      const rw = (r.wait && typeof r.wait === "object" ? r.wait : {}) as Record<string, unknown>;
      const wl = str(rw.label).trim();
      if (!wl) err("a wait step needs a label (what it waits for, e.g. \"Reply received\").");
      else if (wl.length > FLOW_WAIT_LABEL_MAX) err(`wait labels are up to ${FLOW_WAIT_LABEL_MAX} characters.`);
      const resolvers = Array.isArray(rw.resolvers) ? rw.resolvers.map(str) : [];
      if (rw.resolvers != null && !Array.isArray(rw.resolvers)) err("wait resolvers must be a list of bots.");
      for (const b of resolvers) if (!ctx.dir.bots.has(b)) err("a wait resolver isn't one of this organisation's bots.");
      const days = rw.remindAfterDays;
      if (days != null && !(Number.isInteger(days) && (days as number) >= 1 && (days as number) <= FLOW_REMIND_MAX_DAYS)) {
        err(`reminders are 1-${FLOW_REMIND_MAX_DAYS} days, or none.`);
      }
      wait = { label: wl, resolvers: [...new Set(resolvers)], remindAfterDays: days == null ? null : (days as number) };
    } else if (r.wait != null) {
      err("only a wait step has wait settings.");
    }
    if (status.stage === "done" && advance === "wait") err("the done step can't wait.");

    if (r.required != null && typeof r.required !== "boolean") err("required must be true or false.");
    const next = r.next == null || r.next === "" ? null : str(r.next);

    steps.push({
      id,
      name,
      status,
      owner,
      ...(instructions ? { instructions } : {}),
      advance,
      ...(wait ? { wait } : {}),
      required: r.required !== false,
      next,
    });
  });

  const ids = new Set(steps.map((s) => s.id));
  steps.forEach((s, i) => {
    const label = s.name || `Step ${i + 1}`;
    if (s.next != null) {
      if (s.next === s.id) stepErr(i, label, "can't jump to itself.");
      else if (!ids.has(s.next)) stepErr(i, label, "its jump target isn't a step of this flow.");
    }
    if (s.status.stage === "done") {
      if (i < steps.length - 1) stepErr(i, label, "nothing can come after a done step. Move it to the end.");
      if (s.next) stepErr(i, label, "the done step ends the flow; it can't jump elsewhere.");
    }
    const prev = steps[i - 1];
    if (prev && sameStatus(prev.status, s.status) && sameOwner(prev.owner, s.owner)) {
      stepErr(i, label, `has the same status and owner as ${prev.name || `step ${i}`}. Merge them or change one.`);
    }
  });
  const last = steps[steps.length - 1];
  if (last && last.status.stage !== "done") {
    errors.push("The last step must be a done step.");
    flowErrors.push("The last step must be a done step.");
  }

  return errors.length ? { ok: false, errors: [...new Set(errors)], stepErrors, flowErrors } : { ok: true, steps };
}

function sameStatus(a: FlowStepStatus, b: FlowStepStatus) {
  if (a.statusId || b.statusId) return a.statusId === b.statusId;
  return a.stage === b.stage && (a.name ?? "").toLowerCase() === (b.name ?? "").toLowerCase();
}
function sameOwner(a: FlowStepOwner, b: FlowStepOwner) {
  return a.kind === b.kind && (a.id ?? null) === (b.id ?? null);
}
