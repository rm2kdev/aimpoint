import type { ObjectId } from "mongodb";

export type Role = "admin" | "member";
/**
 * Workflow stage of a status. "triage" sits between backlog and not-started: new work that still has to be
 * broken down into concrete tasks, which triage bots pick up through check_for_triage.
 */
export type StatusCategory = "backlog" | "triage" | "unstarted" | "started" | "done" | "cancelled";
/** Done and cancelled tasks are closed: they no longer hold up the tasks that depend on them. */
export const isClosedCategory = (c: StatusCategory | null | undefined) => c === "done" || c === "cancelled";
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
  createdAt: Date;
}
export interface ProjectMetaEntry {
  key: string;
  value: string;
}
export interface StatusDoc {
  _id: ObjectId;
  orgId: ObjectId;
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
   * The umbrella became ready and its triager (`botId`, = triagedBy then) was asked to close it out.
   * `deliveredAt` is null until a push wake-up succeeds or check_for_work hands it out, so a polling
   * triager finds it once. Replaced each time the task becomes ready again; cleared on re-triage.
   */
  closeout?: { botId: ObjectId; requestedAt: Date; deliveredAt: Date | null } | null;
  /**
   * Manual order (VEC-57): fractional index key from lib/rank.ts, one key space per organisation, smaller =
   * higher. Backfilled once by the `2026-11-task-rank` migration; new tasks get one above everything else.
   */
  rank?: string;
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
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
export type ActivityNote = "started_work" | "resumed_work";

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
    | "unblocked";
  from?: string | null;
  to?: string | null;
  /**
   * Why Vector made the change itself. "started_work": a bot picked the task up, so it moved to In Progress.
   * "resumed_work": its assigned bot was @mentioned after finishing, so it's back at work and In Progress.
   */
  note?: ActivityNote;
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
  createdBy: ObjectId;
  createdAt: Date;
}

export const BOT_MAX_TASKS_DEFAULT = 3;
export const BOT_MAX_TASKS_MIN = 1;
export const BOT_MAX_TASKS_MAX = 20;
/** A bot's max concurrent tasks, falling back to the default for bots saved before the setting existed. */
export const botMaxTasks = (b: { maxTasks?: number | null }) =>
  Number.isInteger(b.maxTasks) && b.maxTasks! >= BOT_MAX_TASKS_MIN && b.maxTasks! <= BOT_MAX_TASKS_MAX ? b.maxTasks! : BOT_MAX_TASKS_DEFAULT;

/** The backend that runs a bot. Vector calls it when the bot is assigned a task or @mentioned. */
export type BotAgent = "claude" | "openai" | "hermes" | "other";
/** How Vector reaches the backend. See src/lib/bot-connect.ts. */
export type BotMethod = "claude-api" | "openai-api" | "hermes-api" | "webhook" | "mcp";

export interface BotDelivery {
  at: Date;
  ok: boolean;
  /** "assigned WEB-12", "mentioned on WEB-12", "test" */
  reason: string;
  status?: number;
  error?: string;
}

export interface BotConnectionDoc {
  agent: BotAgent;
  method: BotMethod;
  /** Hermes API server base URL or webhook URL. */
  url?: string;
  /** Model id for direct API methods. */
  model?: string;
  /** Vector's origin, recorded at setup: task links in wake-ups, and the MCP URL for providers that call back. */
  vectorUrl?: string;
  /** AES-GCM sealed secret: Hermes API key, webhook signing secret or provider API key. */
  secretSealed?: string;
  secretHint?: string;
  /** Sealed copy of the bot's own Vector key, for Claude/OpenAI, which call Vector's MCP server on the bot's behalf. */
  vectorKeySealed?: string;
  updatedAt: Date;
  lastDelivery?: BotDelivery;
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
  state: "in_progress" | "done";
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
/** "review": a bot finished a task but left it open (e.g. In Review) while other tasks wait on it. */
export type NotificationKind = "assigned" | "mentioned" | "ready" | "review";
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
}
export interface ProjectDetail extends Project {
  metadata: ProjectMetaEntry[];
  createdAt: string;
  archivedAt: string | null;
}
export interface Status {
  id: string;
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
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
/**
 * An open task that other open tasks are waiting on, with nobody moving it forward:
 * "finished": its assignee is a bot that called complete_task but left it open (e.g. In Review), so no bot will
 * touch it again and the waiting tasks only move once a person closes it.
 * "unassigned": nobody is assigned to it.
 * "needs_owner": nobody is assigned, but it is still waiting on open dependencies of its own, so it isn't holding
 * anything up yet. Not stalled: a softer hint (neutral, not red) to give it an owner before those clear (VEC-86).
 * A person assignee, or a bot that hasn't picked it up yet or is working on it, isn't stalled.
 */
export interface Stalled {
  reason: StalledReason;
  /** Bot that finished it ("finished" only). */
  botId: string | null;
  /** Keys of the open tasks waiting on it, e.g. ["VEC-16", "VEC-17"]. */
  blocking: string[];
}
export type StalledReason = "finished" | "unassigned" | "needs_owner";
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
  createdAt: string;
}
export interface Counts {
  my: number;
  all: number;
  archived: number;
  projects: Record<string, number>;
}
