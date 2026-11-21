import type { ObjectId } from "mongodb";
import type { FlowAdvance, FlowMode, FlowSource, StepOwnerKind } from "./flow-model";
import type { FormField } from "./form-fields-core";

export type Role = "admin" | "member";
/**
 * Workflow stage of a status. "triage" sits between backlog and not-started: new work that still has to be
 * broken down into concrete tasks, which triage bots pick up through check_for_triage.
 */
export type StatusCategory = "backlog" | "triage" | "unstarted" | "started" | "done" | "cancelled";
/** Done and cancelled tasks are closed: they no longer hold up the tasks that depend on them. */
export const isClosedCategory = (c: StatusCategory | null | undefined) => c === "done" || c === "cancelled";
/** Every stage, in workflow order. Stages are fixed; each project names its own statuses on top of them. */
export const STATUS_STAGES: readonly StatusCategory[] = ["backlog", "triage", "unstarted", "started", "done", "cancelled"];
/**
 * Stages every project must keep at least one status in (VEC-114), so triage, bot hand-offs and close-outs
 * always resolve to a status of the task's own project. "started" may be left out.
 */
export const REQUIRED_STAGES: readonly StatusCategory[] = ["backlog", "triage", "unstarted", "done", "cancelled"];
/** Required stages a project's status list has no status in (empty = the list is valid). */
export function missingStages(list: readonly { category: StatusCategory }[]): StatusCategory[] {
  return REQUIRED_STAGES.filter((stage) => !list.some((s) => s.category === stage));
}
type StatusLike = { name: string; category: StatusCategory; order: number };
const byOrder = <S extends StatusLike>(list: readonly S[]) => [...list].sort((a, b) => a.order - b.order);
/**
 * Resolves a status reference within ONE project's status list: an exact id (via `idOf`), else a name
 * (case-insensitive), else a stage (first status of that stage in workflow order). Null when nothing matches.
 */
export function pickStatus<S extends StatusLike>(list: readonly S[], ref: string, idOf?: (s: S) => string): S | null {
  const r = ref.trim();
  if (!r) return null;
  const sorted = byOrder(list);
  if (idOf) {
    const hit = sorted.find((s) => idOf(s) === r);
    if (hit) return hit;
  }
  const lower = r.toLowerCase();
  return sorted.find((s) => s.name.toLowerCase() === lower) ?? sorted.find((s) => s.category === lower) ?? null;
}
/**
 * The status in `list` (another project's statuses) that corresponds to `from`: same name and stage, else the
 * first status of the same stage, else the first not-started one. Keeps the task's stage whenever the project has it.
 */
export function matchStatus<S extends StatusLike>(list: readonly S[], from: StatusLike): S | null {
  const sorted = byOrder(list);
  const name = from.name.toLowerCase();
  return (
    sorted.find((s) => s.category === from.category && s.name.toLowerCase() === name) ??
    sorted.find((s) => s.category === from.category) ??
    sorted.find((s) => s.category === "unstarted") ??
    sorted[0] ??
    null
  );
}
export type TaskType = "issue" | "feature" | "task";
export const TASK_TYPES: readonly TaskType[] = ["issue", "feature", "task"];
export function isTaskType(v: unknown): v is TaskType {
  return typeof v === "string" && (TASK_TYPES as readonly string[]).includes(v);
}
export type Priority = 0 | 1 | 2 | 3; // none, low, medium, high

export interface UserDoc {
  _id: ObjectId;
  email: string;
  name: string;
  passwordHash: string;
  /** Profile picture URL (see saveAvatar); none = initials. */
  image?: string | null;
  /** Bumped to revoke sessions: JWTs issued under an older version are refused (see lib/security.ts). */
  sessionVersion?: number;
  /** One-time nonce that lets the acting session move to the new sessionVersion after a revoke. */
  sessionReissue?: { nonce: string; expiresAt: Date } | null;
  /** Wrong-password counter for reauthenticate(). */
  reauth?: { failures: number; lockedUntil: Date | null };
  /** TOTP two-factor authentication (see lib/two-factor.ts). Absent/null = off. */
  twoFactor?: {
    /** Base32 secret sealed with lib/secrets.ts; never sent to the client after setup. */
    secret: string;
    enabledAt: Date;
    /** Last accepted time step: codes for this step or earlier are refused (replay). */
    lastStep: number;
    /** Keyed hashes of the unused single-use recovery codes. */
    recoveryHashes: string[];
  } | null;
  /** A secret shown during setup, switched on only once a valid code confirms it. */
  twoFactorPending?: { secret: string; createdAt: Date } | null;
  /** Wrong second-factor counter (login step and account actions). */
  twoFactorAttempts?: { failures: number; lockedUntil: Date | null };
  /**
   * "What's new" (VEC-373, lib/changelog-core.ts): id of the newest changelog milestone this person dismissed.
   * Only moves forward. Missing = nothing dismissed: an account that predates a milestone sees it once, while
   * milestones released before `createdAt` never show. New signups are stamped with the newest milestone.
   */
  changelogSeen?: string | null;
  createdAt: Date;
}
/** Second sign-in step: the password was right, the code is still owed. Stored by token hash; expires. */
export interface LoginChallengeDoc {
  _id: ObjectId;
  tokenHash: string;
  userId: ObjectId;
  attempts: number;
  expiresAt: Date;
}
export interface OrgDoc {
  _id: ObjectId;
  name: string;
  slug: string;
  createdAt: Date;
  /** Org-wide defaults (VEC-128). Absent fields read as their preset (see loadOrgDefaults). */
  defaults?: Partial<OrgDefaults>;
  /** Stripe subscription state (VEC-222), written by the Stripe webhook. Absent = never subscribed (unpaid, so locked, when billing is on; VEC-262). */
  billing?: OrgBilling;
}
/** Stripe subscription statuses (https://docs.stripe.com/api/subscriptions/object#subscription_object-status). */
export type BillingStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "incomplete"
  | "incomplete_expired"
  | "paused";
/** An org's billing state, read by `lib/billing.ts` getPlan (VEC-222). */
export interface OrgBilling {
  stripeCustomerId?: string | null;
  subscriptionId?: string | null;
  status?: BillingStatus | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd?: boolean;
  /** When a canceled subscription ended (Stripe ended_at, VEC-231); null while live. */
  endedAt?: Date | null;
  /** When the subscription went past_due; the Pro grace period counts from here (else from currentPeriodEnd). */
  pastDueSince?: Date | null;
  /** Seats on the subscription (its item quantity, from the webhook, VEC-238): billed at US$4.95 each per month. */
  seats?: number | null;
  /** The subscription's discount (a coupon, usually from a promotion code at Checkout, VEC-311); null when none. */
  discount?: BillingDiscount | null;
  /** `created` time of the newest Stripe webhook event applied (VEC-223); older late arrivals are skipped. */
  lastEventAt?: Date | null;
  updatedAt?: Date;
}
/** A Stripe discount on the Pro subscription as stored from the webhook (VEC-311). Coupons live in the Stripe dashboard. */
export interface BillingDiscount {
  /** The promotion code the customer typed (e.g. AIMPOINTTEST50), null when the coupon was applied directly. */
  code: string | null;
  /** The coupon's name, else null. */
  name: string | null;
  percentOff: number | null;
  /** Fixed amount off each invoice, in the smallest unit of `currency`. */
  amountOffCents: number | null;
  currency: string | null;
  /** Stripe coupon duration: once (one invoice), repeating (durationInMonths), forever. */
  duration: string | null;
  durationInMonths: number | null;
  /** When the discount stops applying (repeating coupons), else null. */
  endsAt: Date | null;
}
/**
 * Stages a person's new task may start in by default (VEC-128): open stages only, never done/cancelled.
 * The org stores a stage, not a status id, because statuses are per project (VEC-114).
 */
export const DEFAULT_STAGES = ["backlog", "triage", "unstarted", "started"] as const satisfies readonly StatusCategory[];
export type DefaultStage = (typeof DEFAULT_STAGES)[number];
export const isDefaultStage = (v: unknown): v is DefaultStage => typeof v === "string" && (DEFAULT_STAGES as readonly string[]).includes(v);
/** Preset when the org never saved one: people's new tasks start in Triage. */
export const DEFAULT_NEW_TASK_STAGE: DefaultStage = "triage";
export interface OrgDefaults {
  /** Stage a task created by a person without a status starts in (the project's first status of that stage). */
  newTaskStage: DefaultStage;
}
/** Where a new task's default status came from (VEC-190): the project's override, the org default stage, or the not-started fallback. */
export type NewTaskStatusSource = "project" | "org" | "fallback";
/**
 * The status a person's new task with no explicit status starts in, within ONE project's statuses (VEC-190):
 * the project's override (`overrideId`, if it is still one of `list` and in an open default stage), else the
 * project's first status of the org default stage, else its first not-started one, else its first status.
 * Client-safe so the new-task dialog derives exactly what the server will do. Bots don't use this (see task-service).
 */
export function newTaskStatusIn<S extends StatusLike>(
  list: readonly S[],
  overrideId: string | null | undefined,
  orgStage: StatusCategory,
  idOf: (s: S) => string,
): { status: S | null; source: NewTaskStatusSource } {
  const sorted = byOrder(list);
  const own = overrideId ? sorted.find((s) => idOf(s) === overrideId && isDefaultStage(s.category)) : undefined;
  if (own) return { status: own, source: "project" };
  const ofStage = sorted.find((s) => s.category === orgStage);
  if (ofStage) return { status: ofStage, source: "org" };
  return { status: sorted.find((s) => s.category === "unstarted") ?? sorted[0] ?? null, source: "fallback" };
}
export interface MembershipDoc {
  _id: ObjectId;
  orgId: ObjectId;
  userId: ObjectId;
  role: Role;
  createdAt: Date;
  /** This person's sidebar project order in this org (VEC-53). Unlisted projects follow by createdAt. */
  projectOrder?: ObjectId[];
  /** When projectOrder was last saved; lets clients keep the newer of server render vs live events. */
  projectOrderAt?: Date;
}
export interface ProjectDoc {
  _id: ObjectId;
  orgId: ObjectId;
  name: string;
  key: string;
  color: string;
  nextNumber: number;
  /** Free-form key/value context handed to agents with every task in this project. Order is kept. */
  metadata?: ProjectMetaEntry[];
  /** Archived projects keep their tasks but take no new ones and leave the sidebar. */
  archivedAt?: Date | null;
  /** Project flow (VEC-174): absent = "inherit" the org default; "custom" = its own FlowDoc; "off" = no flow. */
  flowMode?: FlowMode;
  /** Project-level defaults (VEC-190). Absent fields inherit the org's (OrgDoc.defaults). */
  defaults?: ProjectDefaultsDoc;
  /** Public project (VEC-254/255): absent = private. Managed by admins through lib/project-public.ts. */
  publicAccess?: ProjectPublicAccessDoc | null;
  createdAt: Date;
}
/**
 * Public project settings (VEC-255). `enabled`: anyone can read the project's non-archived tasks through the
 * sanitised public view (lib/project-public.ts), and any signed-in Aimpoint account can submit a ticket into
 * `submitStatusIds` (this project's own statuses, stage backlog / triage / unstarted, same rule as
 * FORM_DESTINATION_STAGES; the first is the default destination; empty = read-only). `showComments` adds comments
 * to the public view (author display names only). `showStats` (VEC-363, absent = off) serves task counts at
 * `/api/public/<org>/<KEY>/stats` and shields.io badges at `.../badge/<metric>`. Kept valid by the status/project
 * hooks in lib/project-public.ts.
 */
export interface ProjectPublicAccessDoc {
  enabled: boolean;
  submitStatusIds: ObjectId[];
  showComments: boolean;
  showStats?: boolean;
  updatedAt: Date;
  updatedBy: ObjectId;
}
/** Client-safe ProjectPublicAccessDoc (settings UI, server action results). A private project reads as the defaults. */
export interface ProjectPublicAccess {
  projectId: string;
  enabled: boolean;
  submitStatusIds: string[];
  showComments: boolean;
  showStats: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}
/** One status as the public sees it. */
export interface PublicStatus {
  id: string;
  name: string;
  color: string;
  stage: StatusCategory;
}
/** One task as the public sees it (no ids, people, flow, claims, activity or agent context). */
export interface PublicTask {
  key: string;
  title: string;
  type: TaskType;
  status: PublicStatus | null;
  priority: Priority;
  /** Sanitised HTML; local upload images point at the public image route. */
  description: string;
  createdAt: string;
  updatedAt: string;
}
/** A comment in the public view (only when the project shows comments). Mentions read as @Name. */
export interface PublicComment {
  author: string;
  body: string;
  createdAt: string;
}
export interface PublicProjectView {
  org: { name: string; slug: string };
  project: { name: string; key: string; color: string };
  statuses: PublicStatus[];
  /** Statuses a signed-in account may submit into, in the admin's order (first = default). Empty = read-only. */
  submitStatuses: PublicStatus[];
  showComments: boolean;
  tasks: PublicTask[];
  /** More non-archived tasks exist than were returned. */
  truncated: boolean;
  /** Task counts by stage (VEC-364) when the project shows statistics (`publicAccess.showStats`), else null. */
  stats: { open: number; inProgress: number; done: number; total: number } | null;
}
/**
 * What the public loader returns for a project that is public: the view, or `unavailable` while the org's plan
 * lacks the feature (the page shows a short message; nothing about the project or plan is in it).
 */
export type PublicProjectResult = { available: true; view: PublicProjectView } | { available: false };
/**
 * External forms (VEC-204/205): a public form hosted by a project. Each submission becomes a task in the form's
 * project, in `destinationStatusId` (one of that project's own statuses, stage backlog / triage / unstarted), with
 * the type set by `typeMode`. Managed by admins through lib/project-forms.ts; submitted through createTaskFromForm.
 */
export interface ProjectFormDoc {
  _id: ObjectId;
  orgId: ObjectId;
  projectId: ObjectId;
  name: string;
  /** Unguessable id used in the public URL (`/f/<publicId>`). Unique across all orgs. */
  publicId: string;
  enabled: boolean;
  /**
   * Set when Aimpoint switched the form off itself (its status was deleted or left the allowed stages and nothing
   * equivalent was left to re-map to), so the settings UI can say why. Cleared when an admin re-enables it.
   */
  disabledReason?: string | null;
  destinationStatusId: ObjectId;
  /** "fixed": every submission gets `type`. "choose": the submitter picks one of `allowedTypes` (`type` = the preselected one). */
  typeMode: FormTypeMode;
  type: TaskType;
  /** With typeMode "choose": the types a submitter may pick (2+). Empty for "fixed". */
  allowedTypes: TaskType[];
  /** Plain text shown above the form. */
  intro?: string | null;
  /**
   * VEC-233: the description uses the rich text editor instead of a plain textarea. Missing on forms saved before
   * it existed, which reads as false (`toProjectForm`, `findOpenForm` fill it in).
   */
  richText?: boolean;
  /** VEC-233: submitters may add images (public uploads). Only ever true together with `richText`. */
  allowImages?: boolean;
  /**
   * TPA-399: extra questions after title/description, in form order (lib/form-fields-core.ts). Missing on forms
   * saved before it existed, which reads as none.
   */
  fields?: FormField[];
  /** TPA-399: plain text shown under the optional Email field (e.g. why it's asked). */
  emailHelp?: string | null;
  /** TPA-399: leave out the generic description box (only with at least one text field). Missing = shown. */
  hideDescription?: boolean;
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
export type FormTypeMode = "fixed" | "choose";
export type { FormField, FormFieldKind } from "./form-fields-core";
/** Stages a form may file into: never started/done/cancelled work. */
export const FORM_DESTINATION_STAGES = ["backlog", "triage", "unstarted"] as const satisfies readonly StatusCategory[];
export const isFormDestinationStage = (v: unknown): v is (typeof FORM_DESTINATION_STAGES)[number] =>
  typeof v === "string" && (FORM_DESTINATION_STAGES as readonly string[]).includes(v);
/** Client-safe form (settings UI, server action results). */
export interface ProjectForm {
  id: string;
  projectId: string;
  name: string;
  publicId: string;
  enabled: boolean;
  disabledReason: string | null;
  destinationStatusId: string;
  typeMode: FormTypeMode;
  type: TaskType;
  allowedTypes: TaskType[];
  intro: string | null;
  richText: boolean;
  allowImages: boolean;
  fields: FormField[];
  emailHelp: string | null;
  hideDescription: boolean;
  createdAt: string;
  updatedAt: string;
}
/**
 * An image uploaded through a public form (VEC-233, `POST /api/forms/<publicId>/uploads`), kept as pending until a
 * submission of the same form claims it (`claimedTaskId`). Unclaimed ones are deleted with their file after
 * FORM_UPLOAD_PENDING_MS (lib/form-uploads.ts); `expiresAt` is a TTL backstop, unset once claimed.
 */
export interface FormUploadDoc {
  _id: ObjectId;
  /** Stored file name (`<orgId>-<random>.<ext>`). */
  name: string;
  /** What the uploader got back and the description will reference. */
  url: string;
  /** Owner (VEC-356): the form it was uploaded to, or the public project (`publicProjectId`). Exactly one is set. */
  formId?: ObjectId;
  /** A public project's upload (VEC-356): only the same account's submission to that project may claim it. */
  publicProjectId?: ObjectId;
  /** The signed-in account that uploaded it (public project uploads only). */
  userId?: ObjectId;
  orgId: ObjectId;
  /** Keyed hash of the uploader's IP (never the raw IP). */
  ipHash: string;
  type: string;
  size: number;
  createdAt: Date;
  claimedTaskId: ObjectId | null;
  expiresAt?: Date;
}
/** Where a task came from when not created in the app/API by a member or bot (VEC-205, VEC-255). */
export type TaskSourceDoc = FormTaskSourceDoc | PublicTaskSourceDoc;
/**
 * Submitted on a public project's page (VEC-255) by a signed-in Aimpoint account that need not be a member.
 * `createdBy` is then the project's id (no person), so the submitter gets no edit rights or org access from it.
 */
export interface PublicTaskSourceDoc {
  kind: "public";
  userId: ObjectId;
  /** The account's display name at submission time. Never its email. */
  userName: string;
}
export interface FormTaskSourceDoc {
  kind: "form";
  formId: ObjectId;
  /** The form's name at submission time (the form may be renamed or deleted later). */
  formName: string;
  submitterName?: string | null;
  submitterEmail?: string | null;
}
export interface ProjectDefaultsDoc {
  /**
   * Status (one of THIS project's own, open stage) a person's new task without an explicit status starts in.
   * Unset = inherit the org default stage. Cleared when that status is deleted or leaves the open stages.
   */
  newTaskStatusId?: ObjectId;
}
export interface ProjectMetaEntry {
  key: string;
  value: string;
}
export interface StatusDoc {
  _id: ObjectId;
  orgId: ObjectId;
  /** The project that owns this status (VEC-114). Every task's statusId points at a status of its own project. */
  projectId: ObjectId;
  name: string;
  color: string;
  category: StatusCategory;
  order: number;
}
export interface TaskDoc {
  _id: ObjectId;
  orgId: ObjectId;
  projectId: ObjectId;
  number: number;
  title: string;
  description: string; // sanitised HTML from the editor
  type: TaskType;
  statusId: ObjectId;
  assigneeId: ObjectId | null;
  priority: Priority;
  /** Calendar date (stored as UTC midnight). */
  dueDate?: Date | null;
  archivedAt?: Date | null;
  archivedBy?: ObjectId | null;
  /** Tasks that must reach a done status before this one is ready for work. Same organisation, any project. */
  dependsOn?: ObjectId[];
  /** The part of `dependsOn` that isn't done yet. Empty or missing = ready. Kept in step by lib/dependencies.ts. */
  waitingOn?: ObjectId[];
  /**
   * The bot that last finished triaging this task (complete_task on its triage claim). It keeps close-out
   * rights on it: comment, and move it to a closing status once nothing it depends on is open.
   * Cleared when the task goes back into Triage; the next triage sets it again.
   */
  triagedBy?: ObjectId | null;
  /**
   * VEC-263: the org was locked (hosted, no live subscription) when this task landed in Triage, so no push triager was
   * woken. The wake sweep offers it again once the org is usable.
   */
  triageHeld?: { at: Date; exclude: ObjectId | null } | null;
  /**
   * The umbrella became ready and its triager (`botId`, = triagedBy then) was asked to close it out.
   * `deliveredAt` is null until a push wake-up succeeds or check_for_work hands it out, so a polling
   * triager finds it once. `resolvedAt` is set once that bot has handled it (complete_task on the task, or a status
   * change by it); until then the close-out is pending and the task isn't "finished" Stalled (VEC-89).
   * Replaced each time the task becomes ready again; cleared on re-triage.
   */
  closeout?: { botId: ObjectId; requestedAt: Date; deliveredAt: Date | null; resolvedAt?: Date | null } | null;
  /**
   * Manual order (VEC-57): fractional index key from lib/rank.ts, one key space per organisation, smaller =
   * higher. Backfilled once by the `2026-11-task-rank` migration; new tasks get one above everything else.
   */
  rank?: string;
  /**
   * VEC-108: set when Aimpoint told someone this task went red Stalled because nobody owns it (a "stalled"
   * notification), so it isn't sent again while that lasts; cleared once the task leaves that state (re-arms).
   */
  stalledNoticeAt?: Date | null;
  /** Position in the project's flow (docs/flows.md, VEC-174/175). Absent = not positioned yet (lazy). */
  flow?: TaskFlowState | null;
  /** Set when the task was submitted through an external form (VEC-205); `createdBy` is then the form's id. */
  source?: TaskSourceDoc | null;
  /**
   * VEC-215: a person stopped the bot working on it (lib/stop-work.ts). While set, no assigned / ready / handoff /
   * close-out / triage wake-up goes out for it and the bot's claim sits in state "stopped". Resume clears it.
   */
  stopped?: TaskStopDoc | null;
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
/** Who stopped which bot's work on a task, and what Resume has to undo (VEC-215). */
export interface TaskStopDoc {
  by: ObjectId;
  at: Date;
  /** The bot whose work was stopped. */
  botId: ObjectId;
  /** It was working on the task as its assignee, or triaging it. */
  kind: "assigned" | "triage";
  /** Stop paused the task's flow (it wasn't paused already), so Resume resumes it. */
  pausedFlow: boolean;
}
/** Client-safe TaskStopDoc. */
export interface TaskStop {
  by: string;
  at: string;
  botId: string;
  kind: "assigned" | "triage";
}
/** A task's place in its flow (written by the flow engine, VEC-175). */
export interface TaskFlowState {
  /** Null = detached: the status matches no step; re-attaches on the next status change into a step status. */
  stepId: string | null;
  source: FlowSource;
  version: number;
  enteredAt: Date;
  /** A person assigned someone else during this step; the next advance applies flow owners again. */
  ownerOverride?: boolean;
  /** The flow is switched off for this task (or it became a triage umbrella). */
  paused?: boolean;
  /** Who paused it (VEC-325): the triage split ("umbrella") or a person's Pause / Stop. Unset on older pauses. */
  pausedBy?: "umbrella" | "person";
  /** Wait steps: when the reminder went out (once per entry). */
  remindedAt?: Date | null;
}
/**
 * A flow (VEC-174, docs/flows.md section 3): the org default (projectId null, one per org) or a project's
 * override (flowMode "custom"). Unique {orgId, projectId}. Steps in pipeline order; ids as ObjectIds here,
 * hex strings in the client-safe model (lib/flow-model.ts, converted by lib/flows.ts).
 */
export interface FlowDoc {
  _id: ObjectId;
  orgId: ObjectId;
  projectId: ObjectId | null;
  /** Bumped on every save. */
  version: number;
  steps: FlowStepDoc[];
  updatedAt: Date;
  updatedBy: ObjectId | null;
}
export interface FlowStepDoc {
  id: string;
  name: string;
  status: { statusId?: ObjectId | null; stage: StatusCategory; name?: string | null; deleted?: boolean };
  owner: { kind: StepOwnerKind; id?: ObjectId | null; removed?: { kind: "bot" | "person"; name: string } | null };
  instructions?: string;
  advance: FlowAdvance;
  wait?: { label: string; resolvers?: ObjectId[]; remindAfterDays?: number | null } | null;
  required?: boolean;
  next?: string | null;
}
export interface CommentDoc {
  _id: ObjectId;
  orgId: ObjectId;
  taskId: ObjectId;
  authorId: ObjectId;
  /** Plain text; mentions are encoded as <@24-hex-id>. */
  body: string;
  mentions?: ObjectId[];
  createdAt: Date;
}
export type ActivityNote =
  | "started_work"
  | "resumed_work"
  | "auto_owner"
  | "closeout"
  /** flow_step (VEC-175): handed on to the next step / sent back to an earlier one / followed a status edit / paused as a triage umbrella. */
  | "advanced"
  | "back"
  | "synced"
  | "umbrella"
  /** flow_step (VEC-183): a person paused the task's flow / resumed it (re-synced by status). */
  | "paused"
  | "resumed"
  /** stopped (VEC-215): the bot was triaging the task, not working on it as assignee. */
  | "triage"
  /** created (VEC-205): submitted through an external form; `to` holds the form's name at the time. */
  | "form"
  /** created (VEC-255): submitted on the public project page; `to` holds the submitter's display name. */
  | "public"
  /** status (VEC-215): a person stopped the bot's work, so it moved back to the first not-started status. */
  | "stopped_work";

export interface ActivityDoc {
  _id: ObjectId;
  orgId: ObjectId;
  taskId: ObjectId;
  actorId: ObjectId;
  kind:
    | "created"
    | "status"
    | "assignee"
    | "priority"
    | "type"
    | "title"
    | "project"
    | "due"
    | "archived"
    | "restored"
    /** `to` holds the dependency's key at the time. */
    | "dependency_added"
    | "dependency_removed"
    /** Every dependency is done. `from` holds the key(s) of the one(s) that finished it, comma-separated. */
    | "unblocked"
    /** VEC-159: the actor asked Aimpoint to hand the task to its bot again (`to` = the bot's id). `note` "closeout"
     * when it re-sent a triager's close-out rather than the work itself. */
    | "retried"
    /** VEC-215: the actor stopped a bot's work on the task (`to` = the bot's id; `note` "triage" when it was triaging). */
    | "stopped"
    /** VEC-215: the actor resumed it (`to` = the bot handed it, null = nobody to hand it to yet). */
    | "resumed"
    /** VEC-175: the flow moved it to another step. `from`/`to` = step names, `flowStatus` = the step's status name,
     * `flowOwner` = who it was handed to (id hex, null = nobody), `note` = advanced | back | synced | umbrella. */
    | "flow_step";
  from?: string | null;
  to?: string | null;
  /**
   * Why Aimpoint made the change itself. "started_work": a bot picked the task up, so it moved to In Progress.
   * "resumed_work": its assigned bot was @mentioned after finishing, so it's back at work and In Progress.
   * "auto_owner" (on an assignee change): nobody owned it and the actor bot parked its own task behind it, so
   * Aimpoint assigned it to that bot (VEC-107). `waiter` holds the waiting task's key.
   */
  note?: ActivityNote;
  /** With note "auto_owner": key of the task that was waiting on this one. */
  waiter?: string | null;
  /** flow_step: name of the status the new step sits in. */
  flowStatus?: string | null;
  /** flow_step: who the step handed it to (id hex), null = nobody. */
  flowOwner?: string | null;
  createdAt: Date;
}
export interface InviteDoc {
  _id: ObjectId;
  orgId: ObjectId;
  email: string;
  role: Role;
  token: string;
  invitedBy: ObjectId;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt?: Date;
}

export type BotShape = "star" | "heart" | "flower" | "cloud" | "bolt" | "moon" | "blob" | "ghost";
export type BotAvatar = { kind: "shape"; shape: BotShape; color: string } | { kind: "image"; url: string };

export interface BotDoc {
  _id: ObjectId;
  orgId: ObjectId;
  name: string;
  description: string;
  avatar: BotAvatar;
  keyHash: string; // sha256 of the API key; the key itself is shown once
  keyHint: string; // "vec_…abcd"
  keyRotatedAt: Date;
  lastUsedAt?: Date;
  /** Bot role limiting which MCP tools it sees. Unset = every tool. */
  roleId?: ObjectId | null;
  /** How the agent behind this bot hears about work. Set by the connect wizard. */
  connection?: BotConnectionDoc | null;
  /** How many tasks the bot works on at once (display only for now). Unset on older bots: read as BOT_MAX_TASKS_DEFAULT. */
  maxTasks?: number;
  /** The latest "install Aimpoint's MCP server" run sent to a Hermes connection (VEC-169, lib/bot-mcp-install.ts). */
  mcpInstall?: BotMcpInstallDoc | null;
  /** Name the bot's MCP client has Aimpoint's server under (lib/mcp-name.ts, VEC-198): "aimpoint". */
  mcpServerName?: string;
  /** VEC-343: when an admin switched the bot off (lib/bot-enabled.ts). Unset or null = enabled, so older bots need no migration. */
  disabledAt?: Date | null;
  /** The admin who disabled it; cleared with disabledAt on re-enable. */
  disabledBy?: ObjectId | null;
  /** VEC-352: every enable/disable toggle, oldest first, capped at BOT_ENABLED_HISTORY_MAX (setBotEnabled). */
  enabledHistory?: { enabled: boolean; at: Date; by: ObjectId }[];
  createdBy: ObjectId;
  createdAt: Date;
}

/**
 * Aimpoint asked the bot's Hermes to add Aimpoint's MCP server to its own config (VEC-169). `phase`: the install run is
 * going (`install`), waiting before a check run (`waiting`, until `nextAt`), or a check run is going (`check`).
 * Never holds the key: that only travels in the install run's input.
 */
export interface BotMcpInstallDoc {
  id: string;
  state: McpInstallState;
  phase: "install" | "waiting" | "check";
  startedAt: Date;
  updatedAt: Date;
  /** The Hermes run being watched (install or check) and when Aimpoint sent it. */
  runId: string | null;
  runStartedAt: Date | null;
  /** When the install run finished, and the tool count it reported. */
  installedAt: Date | null;
  tools: number | null;
  /** Check runs sent so far, and when the next one is due (phase `waiting`). */
  checks: number;
  nextAt: Date | null;
  /** Aimpoint issued the bot a new key for this install (the old one stopped working). */
  keyRerolled: boolean;
  reason: string | null;
  finishedAt: Date | null;
  /** One stepper at a time (after() driver and wizard polls). */
  leaseUntil: Date | null;
}
export type McpInstallState = "pending" | "installed" | "failed";
/** What the wizard polls. */
export interface BotMcpInstall {
  state: McpInstallState;
  phase: BotMcpInstallDoc["phase"];
  startedAt: string;
  finishedAt: string | null;
  tools: number | null;
  checks: number;
  keyRerolled: boolean;
  reason: string | null;
}

export const BOT_MAX_TASKS_DEFAULT = 3;
export const BOT_MAX_TASKS_MIN = 1;
export const BOT_MAX_TASKS_MAX = 20;
/** A bot's max concurrent tasks, falling back to the default for bots saved before the setting existed. */
export const botMaxTasks = (b: { maxTasks?: number | null }) =>
  Number.isInteger(b.maxTasks) && b.maxTasks! >= BOT_MAX_TASKS_MIN && b.maxTasks! <= BOT_MAX_TASKS_MAX ? b.maxTasks! : BOT_MAX_TASKS_DEFAULT;

/** The backend that runs a bot. Aimpoint calls it when the bot is assigned a task or @mentioned. */
export type BotAgent = "claude" | "openai" | "hermes" | "other";
/** How Aimpoint reaches the backend. See src/lib/bot-connect.ts. */
export type BotMethod = "claude-api" | "openai-api" | "hermes-api" | "webhook" | "mcp";

export interface BotDelivery {
  at: Date;
  ok: boolean;
  /** "assigned WEB-12", "mentioned on WEB-12", "test" */
  reason: string;
  status?: number;
  error?: string;
  /** The queued wake-up this attempt was for (BotWakeDoc._id), and which attempt it was (1 = first). Task wake-ups only. */
  wakeId?: ObjectId;
  attempt?: number;
}

export interface BotConnectionDoc {
  agent: BotAgent;
  method: BotMethod;
  /** Hermes API server base URL or webhook URL. */
  url?: string;
  /** Model id for direct API methods. */
  model?: string;
  /** Aimpoint's origin, recorded at setup: task links in wake-ups, and the MCP URL for providers that call back. */
  aimpointUrl?: string;
  /** @deprecated pre-VEC-321 name of aimpointUrl, left on bots scripts/migrate-connection-fields.mjs hasn't reached. Read via connectionAimpointUrl. */
  vectorUrl?: string;
  /** AES-GCM sealed secret: Hermes API key, webhook signing secret or provider API key. */
  secretSealed?: string;
  secretHint?: string;
  /** Sealed copy of the bot's own Aimpoint key, for Claude/OpenAI, which call Aimpoint's MCP server on the bot's behalf. */
  aimpointKeySealed?: string;
  /** @deprecated pre-VEC-321 name of aimpointKeySealed. Read via connectionAimpointKeySealed. */
  vectorKeySealed?: string;
  updatedAt: Date;
  lastDelivery?: BotDelivery;
  /** The last BOT_DELIVERY_HISTORY deliveries, oldest first (lastDelivery is only the newest), so a failure isn't lost to the next one. */
  deliveries?: BotDelivery[];
}

export const BOT_DELIVERY_HISTORY = 20;

/** Task wake-up kinds that are queued and retried until they reach the bot (lib/wake-queue.ts). */
export type QueuedWakeKind = "assigned" | "ready" | "closeout" | "mentioned";

/**
 * A push wake-up that hasn't reached its bot yet (lib/wake-queue.ts). Written before the first attempt and deleted
 * once a delivery succeeds, so a failed or lost send is retried with backoff instead of dropped. One per
 * (bot, task, kind). `failedAt` is set after the last attempt: the task then shows as Stalled ("undelivered") and a
 * person was told (`notifiedAt`).
 */
export interface BotWakeDoc {
  _id: ObjectId;
  orgId: ObjectId;
  botId: ObjectId;
  taskId: ObjectId;
  kind: QueuedWakeKind;
  /** The WakeReason to send (task key, title, who, detail; commentId for mentions). */
  reason: {
    kind: QueuedWakeKind;
    taskId: ObjectId;
    taskKey: string;
    title: string;
    by: string;
    detail?: string;
    commentId?: ObjectId;
    retry?: boolean;
    /** With retry: the hand-back after a person stopped the bot's work and resumed it (VEC-215). */
    resumed?: boolean;
    /** With resumed: the stopped bot's name when the task was reassigned to this bot while stopped (VEC-219). */
    reassignedFrom?: string;
    /** An assigned wake-up from a flow hand-off (VEC-175). */
    handoff?: { fromStep: string | null; toStep: string };
    /** VEC-316: the one follow-up after a run ended without complete_task (lib/unfinished-runs.ts). */
    followUp?: boolean;
  };
  /** Attempts made so far. */
  attempts: number;
  /** When the next attempt is due; also a lease while an attempt is in flight. */
  nextAttemptAt: Date;
  lastError: string | null;
  /** When the hand-off happened: anything the bot did on the task after this means the wake-up reached it. */
  createdAt: Date;
  updatedAt: Date;
  failedAt: Date | null;
  notifiedAt: Date | null;
  /** VEC-263: queued while the org was locked (no live subscription); re-held, not retried on the clock, if it fails. */
  gated?: boolean;
  /** VEC-263: held back while the org is locked; sent (oldest first) by the sweep once it's usable again. */
  heldAt?: Date | null;
}

/** A named set of MCP tool permissions that can be applied to bots. */
export interface BotRoleDoc {
  _id: ObjectId;
  orgId: ObjectId;
  name: string;
  description: string;
  /** tool name -> allowed. Tools missing from the map are denied. */
  tools: Record<string, boolean>;
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Invisible agent state: a bot has picked up an assigned task. Never shown on the task itself.
 * One per (bot, task). Cleared when the task is (re)assigned to the bot, so a fresh assignment is fresh work.
 */
export interface AgentClaimDoc {
  _id: ObjectId;
  orgId: ObjectId;
  botId: ObjectId;
  taskId: ObjectId;
  /**
   * "assigned" (default when missing): the bot picked up a task assigned to it.
   * "triage": the bot is breaking a Triage task down. At most one per task across all bots; while it's
   * in progress the bot may edit the task like its creator (except archiving).
   */
  kind?: "assigned" | "triage";
  /** "stopped" (VEC-215): a person stopped this work (TaskDoc.stopped). Not working, not finished, never handed out. */
  state: "in_progress" | "done" | "stopped";
  /** VEC-216: the Hermes run the push wake-up started for this work, so Stop can cancel it (POST /v1/runs/{id}/stop). */
  runId?: string | null;
  /** VEC-316: what the latest work delivery started, so lib/unfinished-runs.ts can tell when that run ended without
   * complete_task (rules in lib/run-watch-core.ts). Unset on poll bots' claims and claims from before it shipped. */
  watch?: import("./run-watch-core").RunWatch | null;
  /** VEC-316: the follow-up's run also ended without complete_task, so the sweep finished the claim as unfinished
   * (finishedAt = unfinishedAt). The task shows as Stalled "unfinished" until the bot finishes or picks it up again. */
  unfinishedAt?: Date | null;
  claimedAt: Date;
  finishedAt?: Date | null;
}

/** Inbox entry: a comment mentioned a bot. Delivered once through check_for_work. */
export interface BotMentionDoc {
  _id: ObjectId;
  orgId: ObjectId;
  botId: ObjectId;
  taskId: ObjectId;
  commentId: ObjectId;
  createdAt: Date;
  deliveredAt: Date | null;
}

/** Something a person should look at. Bots get wake-ups and check_for_work instead. */
/** "review": a bot finished a task but left it open (e.g. In Review) while other tasks wait on it.
 * "undelivered": Aimpoint couldn't hand a task to its push bot after retrying (actorId = the bot).
 * "stalled": an open, ready task nobody is assigned to is holding other open tasks up (VEC-108).
 * "waiting": a task has sat at a flow wait step longer than its `remindAfterDays` (VEC-182, once per entry). */
export type NotificationKind = "assigned" | "mentioned" | "ready" | "review" | "undelivered" | "stalled" | "waiting";
export interface NotificationDoc {
  _id: ObjectId;
  orgId: ObjectId;
  userId: ObjectId;
  taskId: ObjectId;
  kind: NotificationKind;
  /** Who caused it: the assigner, the commenter, or whoever finished the last dependency. */
  actorId: ObjectId | null;
  commentId?: ObjectId | null;
  /** Short extra line, e.g. "WEB-1 is done" or "Waiting on WEB-1". */
  detail?: string | null;
  createdAt: Date;
  readAt: Date | null;
}

/* ---- serialised shapes sent to the client ---- */
export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  kind: "user" | "bot";
  avatar?: BotAvatar;
  /** People only: profile picture URL. */
  image?: string;
  description?: string;
  /** Bots only: max concurrent tasks. */
  maxTasks?: number;
  /** Bots only: the person who added it (BotDoc.createdBy); may stop / resume its work (VEC-217). */
  ownerId?: string;
  /** Bots only: switched off by an admin (VEC-343/345). Kept in the list so its tasks and history still render. */
  disabled?: boolean;
}
/** How many tasks a bot is working on right now (see loadBotWorkload). Every bot in the org has an entry. */
export interface BotWorkload {
  botId: string;
  active: number;
}
/** A workload snapshot; `at` (ms, taken before the query) orders snapshots so an older one never replaces a newer one. */
export interface WorkloadSnapshot {
  at: number;
  bots: BotWorkload[];
}
export interface Bot {
  id: string;
  name: string;
  description: string;
  avatar: BotAvatar;
  keyHint: string;
  keyRotatedAt: string;
  lastUsedAt: string | null;
  roleId: string | null;
  connection: BotConnection | null;
  maxTasks: number;
  /** The MCP server name to tell this bot's client: "aimpoint". */
  mcpServerName: string;
  /** VEC-343: false while an admin has the bot switched off (kept in the org, but not woken, offered or let in). */
  enabled: boolean;
  /** When it was disabled and by which user id; both null while enabled. */
  disabledAt: string | null;
  disabledBy: string | null;
  /** VEC-352: the last 20 toggles, oldest first (`by` = user id). Empty for a bot never toggled. */
  enabledHistory: { enabled: boolean; at: string; by: string }[];
  createdBy: string;
  createdAt: string;
}
export interface BotConnection {
  agent: BotAgent;
  method: BotMethod;
  url: string | null;
  model: string | null;
  secretHint: string | null;
  updatedAt: string;
  lastDelivery: { at: string; ok: boolean; reason: string; status: number | null; error: string | null } | null;
}
export interface BotRole {
  id: string;
  name: string;
  description: string;
  tools: Record<string, boolean>;
  createdAt: string;
  updatedAt: string;
}
export interface Project {
  id: string;
  name: string;
  key: string;
  color: string;
  archived: boolean;
  /** The project's new-task status override (VEC-190), one of its own statuses; null = inherits the org default. */
  newTaskStatusId: string | null;
  /** Public project switched on (VEC-256 badge; ProjectDoc.publicAccess.enabled). An unpaid (locked) org still hides the public page. */
  public: boolean;
}
export interface ProjectDetail extends Project {
  metadata: ProjectMetaEntry[];
  createdAt: string;
  archivedAt: string | null;
}
export interface Status {
  id: string;
  projectId: string;
  name: string;
  color: string;
  category: StatusCategory;
  order: number;
}
export interface Task {
  id: string;
  projectId: string;
  key: string; // e.g. WEB-12
  number: number;
  title: string;
  type: TaskType;
  statusId: string;
  assigneeId: string | null;
  priority: Priority;
  /** "YYYY-MM-DD" or null */
  dueDate: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
  /** Ids of tasks this one depends on. */
  dependsOn: string[];
  /** Ids of dependencies not done yet. Non-empty = blocked. */
  waitingOn: string[];
  /** Bots that picked this task up (assigned work or triage) and haven't finished or released it. */
  workingBotIds: string[];
  /** Other tasks are waiting on this one but nobody is on it (see Stalled). Null when it isn't stalled. */
  stalled: Stalled | null;
  /** Manual order key (lib/rank.ts); compare as strings, smaller = higher. "" only for a task saved before ranks. */
  rank: string;
  /** Where the flow engine put it (VEC-178): the task pane's stepper and the row's step chip read this. */
  flow?: TaskFlowView | null;
  /**
   * Set when the task came in through an external form (VEC-205/208); `createdBy` is then the form's id, which no
   * member list resolves, so show the form (`formName`) instead. Only ever sent to org members and the org's bots:
   * the public form endpoint must not hand a Task back to the submitter.
   */
  source?: TaskSource | null;
  /** VEC-215: a person stopped the bot's work on it; Resume hands it back. Null / absent = not stopped. */
  stopped?: TaskStop | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
/** Client-safe TaskSourceDoc. */
export type TaskSource = FormTaskSource | PublicTaskSource;
export interface PublicTaskSource {
  kind: "public";
  userId: string;
  userName: string;
}
export interface FormTaskSource {
  kind: "form";
  formId: string;
  /** The form's name when the task was submitted. */
  formName: string;
  submitterName: string | null;
  submitterEmail: string | null;
}
/** A task's flow position as the client sees it (from TaskDoc.flow). Absent / null = never positioned. */
export interface TaskFlowView {
  /** Null = detached (its status matches no step). */
  stepId: string | null;
  paused: boolean;
  enteredAt: string;
}
/**
 * An open task that other open tasks are waiting on, with nobody moving it forward:
 * "finished": its assignee is a bot that called complete_task but left it open (e.g. In Review), so no bot will
 * touch it again and the waiting tasks only move once a person closes it.
 * "unassigned": nobody is assigned to it.
 * "needs_owner": nobody is assigned, but it is still waiting on open dependencies of its own, so it isn't holding
 * anything up yet. Not stalled: a softer hint (neutral, not red) to give it an owner before those clear (VEC-86).
 * "undelivered": its bot (`botId`) was never reached: Aimpoint couldn't deliver the hand-off after retrying, so
 * nobody is working on it even though it says ready. Shown whether or not other tasks wait on it.
 * "unfinished": its bot's run ended without complete_task, and so did the one follow-up Aimpoint sent it (VEC-316),
 * so nobody is moving it. Shown whether or not other tasks wait on it.
 * "finished" also shows without waiters on a flow task its bot finished at a step the flow drives, when it is still at
 * that step with no hand-off (VEC-316).
 * A person assignee, or a bot that hasn't picked it up yet or is working on it, isn't stalled.
 */
export interface Stalled {
  reason: StalledReason;
  /** Bot that finished it ("finished") or couldn't be reached ("undelivered"). */
  botId: string | null;
  /** Keys of the open tasks waiting on it, e.g. ["VEC-16", "VEC-17"]. */
  blocking: string[];
}
export type StalledReason = "finished" | "unassigned" | "needs_owner" | "undelivered" | "unfinished";
/** True for reasons that mean the task really is holding others up (red Stalled), false for the needs_owner hint. */
export const isStalledReason = (r: StalledReason) => r !== "needs_owner";
/** A task mentioned from another task: a dependency or a dependent. */
export interface TaskRef {
  id: string;
  key: string;
  title: string;
  statusId: string;
  assigneeId: string | null;
  archived: boolean;
  /** Bots working on it right now (see Task.workingBotIds). */
  workingBotIds: string[];
}
export interface TaskDetail extends Task {
  description: string;
  /** Tasks this one waits for, in the order they were added. */
  dependencies: TaskRef[];
  /** Tasks that wait for this one. */
  dependents: TaskRef[];
}
export interface Notification {
  id: string;
  kind: NotificationKind;
  taskId: string;
  taskKey: string;
  taskTitle: string;
  taskArchived: boolean;
  actorId: string | null;
  detail: string | null;
  createdAt: string;
  read: boolean;
}
export interface FeedItem {
  id: string;
  kind: "comment" | ActivityDoc["kind"];
  actorId: string;
  body?: string;
  mentions?: string[];
  from?: string | null;
  to?: string | null;
  note?: ActivityNote;
  waiter?: string | null;
  flowStatus?: string | null;
  flowOwner?: string | null;
  createdAt: string;
}
/**
 * What a Retry (lib/retry-handoff.ts, VEC-159) did. `retried`: handed to their bot again. `busy`: left alone because
 * the bot was working on it and posted within the last few minutes (retry again with force). `skipped`: couldn't be
 * retried, with why (nobody assigned, a person's task, in Triage...).
 */
export interface RetryOutcome {
  retried: { key: string; botId: string }[];
  busy: { key: string; botId: string; lastAt: string }[];
  skipped: { key: string; why: string }[];
  /**
   * VEC-352: tasks whose bot is disabled. Nothing was reset or queued for them (no held wake-up either); enable the
   * bot, then retry. `bot` is its name, `why` a ready sentence.
   */
  disabled: { kind: "bot_disabled"; key: string; botId: string; bot: string; why: string }[];
}
/**
 * What Resume (lib/stop-work.ts resumeWorkAs) did (VEC-352). The stop is always cleared; `note` says why the hand-back
 * didn't go out now (its bot is disabled: the wake-up is held until it's enabled), else null.
 */
export interface ResumeOutcome {
  task: Task;
  note: string | null;
  /** The disabled bot the task would have gone to, when that's why `note` is set. */
  botDisabled: { id: string; name: string } | null;
}
/** What adding a comment returns (VEC-352): the feed item plus the mentioned bots that are disabled (held, not delivered). */
export type CommentResult = FeedItem & { heldMentions: { id: string; name: string }[] };
export interface Counts {
  my: number;
  all: number;
  archived: number;
  projects: Record<string, number>;
}

/* ---- analytics (VEC-132): shared by the analytics screen and the export, built by lib/analytics.ts ---- */
export type AnalyticsGranularity = "hour" | "day" | "week" | "month";
export const ANALYTICS_GRANULARITIES: readonly AnalyticsGranularity[] = ["hour", "day", "week", "month"];
export const isAnalyticsGranularity = (v: unknown): v is AnalyticsGranularity =>
  typeof v === "string" && (ANALYTICS_GRANULARITIES as readonly string[]).includes(v);
/** Buckets are cut in the viewer's timezone; AWST when none is given. */
export const DEFAULT_ANALYTICS_TZ = "Australia/Perth";
export interface AnalyticsQuery {
  /** ISO date-time (or Date), inclusive. */
  from: string | Date;
  /** ISO date-time (or Date), exclusive. */
  to: string | Date;
  granularity: AnalyticsGranularity;
  /** Limit everything to one project. */
  projectId?: string | null;
  /** IANA timezone for bucket boundaries, default DEFAULT_ANALYTICS_TZ. */
  tz?: string | null;
  /**
   * Limit to one person or bot (VEC-135): tasks they opened and closed, their comments and interactions;
   * backlog, open-task age and the tasks-right-now breakdowns count tasks assigned to them.
   */
  contributorId?: string | null;
}
/** A count over the period, the previous equal-length period, and per bucket (aligned with AnalyticsReport.buckets). */
export interface AnalyticsCount {
  total: number;
  previous: number;
  series: number[];
}
/** A count split by who did it: people (incl. former and deleted accounts) vs bots. */
export interface AnalyticsSplitCount extends AnalyticsCount {
  people: AnalyticsCount;
  bots: AnalyticsCount;
}
/** Distribution of durations in ms (null when there is nothing to measure). */
export interface AnalyticsDuration {
  count: number;
  medianMs: number | null;
  p90Ms: number | null;
}
export interface AnalyticsDurationSeries extends AnalyticsDuration {
  previous: AnalyticsDuration;
  /** Median per bucket (null = nothing in that bucket). */
  series: (number | null)[];
  p90Series: (number | null)[];
}
/** Open (not done/cancelled) tasks over time. */
export interface AnalyticsBacklog {
  /** Open at the period's start / end, and at the previous period's start. */
  start: number;
  end: number;
  previousStart: number;
  /** Open at the end of each bucket. */
  series: number[];
}
export interface AnalyticsTickets {
  /** Tasks created. */
  opened: AnalyticsSplitCount;
  /** Moves from an open stage into done or cancelled (split by who moved it). */
  closed: AnalyticsSplitCount;
  done: AnalyticsSplitCount;
  cancelled: AnalyticsSplitCount;
  /** Moves from done/cancelled back to an open stage. */
  reopened: AnalyticsCount;
  backlog: AnalyticsBacklog;
  /** Created -> closed, for each close in the period (bucketed by close time). */
  cycleTime: AnalyticsDurationSeries;
  /** Age of the tasks open at the end of the period (previous = at its start; series = at each bucket end). */
  openAge: AnalyticsDurationSeries;
}
export interface AnalyticsMessages {
  comments: AnalyticsSplitCount;
}
export interface AnalyticsInteractions {
  /** Sum of every kind below. */
  total: AnalyticsSplitCount;
  statusChanges: AnalyticsSplitCount;
  assignments: AnalyticsSplitCount;
  /** @mentions written in comments, by who wrote them. */
  mentions: AnalyticsSplitCount;
  /** Dependencies added or removed. */
  dependencyEdits: AnalyticsSplitCount;
  /** A bot picked up assigned work or a triage (agentClaims.claimedAt). */
  botPickups: AnalyticsCount;
  /** A bot finished a claim (complete_task). */
  botCompletions: AnalyticsCount;
  /** Bots @mentioned (botMentions); informational, already part of `mentions`. */
  botsMentioned: AnalyticsCount;
}
export interface AnalyticsBreakdownRow<K> {
  key: K;
  /** Open now. */
  open: number;
  /** Created / closed in the period. */
  opened: number;
  closed: number;
}
export interface AnalyticsBreakdown {
  /** Tasks by stage right now. */
  byStage: Record<StatusCategory, number>;
  byPriority: AnalyticsBreakdownRow<Priority>[];
  byType: AnalyticsBreakdownRow<TaskType>[];
}
export interface AnalyticsProject {
  project: Project;
  opened: AnalyticsCount;
  closed: AnalyticsCount;
  done: AnalyticsCount;
  cancelled: AnalyticsCount;
  comments: AnalyticsCount;
  interactions: AnalyticsCount;
  backlog: AnalyticsBacklog;
  cycleTime: AnalyticsDuration;
  openAge: AnalyticsDuration;
  breakdown: AnalyticsBreakdown;
}
export interface AnalyticsContributor {
  id: string;
  name: string;
  kind: "user" | "bot";
  /** Tasks this actor moved into done / cancelled in the period. */
  tasksClosed: number;
  done: number;
  cancelled: number;
  comments: number;
  /** Status changes, assignments, mentions, dependency edits, bot pickups and completions. */
  interactions: number;
}
export interface AnalyticsReport {
  generatedAt: string;
  period: {
    from: string;
    to: string;
    granularity: AnalyticsGranularity;
    tz: string;
    projectId: string | null;
    /** The person or bot the report is limited to (AnalyticsQuery.contributorId). */
    contributor: { id: string; name: string; kind: "user" | "bot" } | null;
  };
  /** The equal-length period right before, used for every `previous`. */
  previous: { from: string; to: string };
  /** Bucket starts (ISO, UTC instant of the local start); every series has one entry per bucket. */
  buckets: string[];
  tickets: AnalyticsTickets;
  messages: AnalyticsMessages;
  interactions: AnalyticsInteractions;
  breakdown: AnalyticsBreakdown;
  projects: AnalyticsProject[];
  /** Ranked by tasks closed + comments + interactions in the period. */
  contributors: { people: AnalyticsContributor[]; bots: AnalyticsContributor[] };
}
