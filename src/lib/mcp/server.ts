import "server-only";
import { ObjectId, type Filter } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { findTaskByKey, projectContext } from "@/lib/data";
import { groupStatusesByProject, loadStatusWords, resolveProjectStatus, reviewWord, statusFilterIds } from "@/lib/statuses";
import { toolsForBot } from "@/lib/bots";
import { listedToAgents } from "@/lib/bot-enabled";
import { addCommentAs, assignedBlockersOf, createTaskAs, markStartedByBot, moveTask, ownUnownedBlockers, recordTriagedBy, resumeOnMention, updateTaskAs, type Actor, type TaskPatch } from "@/lib/task-service";
import { READY, resolveCloseout, taskKeys } from "@/lib/dependencies";
import { BLOCKER_NOTE, CLOSEOUT_STEPS, PROGRESS_HINT, STOP_NOTE, TRIAGE_STEPS, flowLastNote, wakeTriage } from "@/lib/bot-dispatch";
import { publishWorking } from "@/lib/claims";
import { taskAccess } from "@/lib/access";
import { advanceTarget, atWaitStep, flowBriefing, isParked, loadTaskFlow, ownerName, parkedReason, type AdvanceTarget } from "@/lib/flow-engine";
import { nextStepOf, pausedAsUmbrella, pausedMoveNote, pausedStatusNote } from "@/lib/flow-engine-core";
import { botOrgFlows } from "@/lib/flow-bot-view";
import { botNewTaskViews, NEW_TASKS_NOTE } from "@/lib/project-defaults";
import { notify } from "@/lib/notifications";
import { MCP_TOOLS, type ToolInfo } from "@/lib/mcp/catalog";
import { stopRefusal } from "@/lib/stop-guard";
import { billingOn, orgLockMessage } from "@/lib/billing";
import { computeAnalytics } from "@/lib/analytics";
import { ANALYTICS_PARAM_DOCS, resolveAnalyticsExport } from "@/lib/analytics-export";
import {
  buildTaskContext,
  loadDirectory,
  personName,
  markdownToHtml,
  PRIORITY_LABEL,
  resolvePerson,
  taskUrl,
  ToolInputError,
  type ImageBlock,
} from "@/lib/mcp/context";
import { ANALYTICS_GRANULARITIES, isClosedCategory, isTaskType, type BotDoc, type OrgDoc, type ProjectDoc, type StatusDoc, type TaskDoc } from "@/lib/types";

/* ---------------- types ---------------- */

export interface McpCtx {
  bot: BotDoc;
  org: OrgDoc;
  actor: Actor;
  origin: string;
}

type Content = { type: "text"; text: string } | ImageBlock;
export interface ToolResult {
  content: Content[];
  isError?: boolean;
}
type Args = Record<string, unknown>;

interface ToolImpl {
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  run: (args: Args, ctx: McpCtx) => Promise<ToolResult>;
}

/* ---------------- arg helpers ---------------- */

const str = (args: Args, k: string, required = false): string | undefined => {
  const v = args[k];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolInputError(`\`${k}\` is required.`);
    return undefined;
  }
  if (typeof v !== "string" && typeof v !== "number") throw new ToolInputError(`\`${k}\` must be a string.`);
  return String(v);
};
const bool = (args: Args, k: string, dflt: boolean) => (typeof args[k] === "boolean" ? (args[k] as boolean) : dflt);

const TYPE_DESC = '"issue" = a bug or problem, "feature" = a feature request, "task" = a plain work item that is neither (e.g. a verification or chore). A type, not a status.';
const TASK_ARG = { type: "string", description: 'Task key like "WEB-12" (or the task id).' };
const DEPENDS_ARG = {
  type: "array",
  items: { type: "string" },
  description:
    'Keys of tasks (e.g. ["WEB-12", "OPS-3"]) that must be done before this one is ready. The assignee isn\'t handed the task until all of them are closed (a done or cancelled status); then it\'s released automatically.',
};

/** Task keys or ids -> task ids, in order. */
async function resolveTaskIds(ctx: McpCtx, v: unknown, arg: string): Promise<string[]> {
  if (v === null) return [];
  if (!Array.isArray(v)) throw new ToolInputError(`\`${arg}\` is a list of task keys, e.g. ["WEB-12"].`);
  const out: string[] = [];
  for (const ref of v) out.push((await findTask(ctx, String(ref))).task._id.toHexString());
  return out;
}
const IMAGES_ARG = { type: "boolean", description: "Attach the task's images inline (default true).", default: true };

const text = (t: string): Content => ({ type: "text", text: t });
const json = (v: unknown): Content => text(JSON.stringify(v, null, 2));

async function findTask(ctx: McpCtx, ref: string): Promise<{ task: TaskDoc; project: ProjectDoc }> {
  const c = await cols();
  const s = ref.trim();
  if (/^[a-f0-9]{24}$/i.test(s)) {
    const task = await c.tasks.findOne({ _id: new ObjectId(s), orgId: ctx.org._id });
    const project = task && (await c.projects.findOne({ _id: task.projectId }));
    if (task && project) return { task, project };
  }
  const found = await findTaskByKey(ctx.org._id, s);
  if (!found || !found.task.orgId.equals(ctx.org._id)) {
    throw new ToolInputError(/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(s) ? `There's no task ${s.toUpperCase()}.` : `"${ref}" isn't a task key. Keys look like WEB-12.`);
  }
  return found;
}

async function resolveProject(ctx: McpCtx, ref: string) {
  const c = await cols();
  const s = ref.trim();
  const p = /^[a-f0-9]{24}$/i.test(s)
    ? await c.projects.findOne({ orgId: ctx.org._id, _id: new ObjectId(s) })
    : await c.projects.findOne({ orgId: ctx.org._id, $or: [{ key: s.toUpperCase() }, { name: { $regex: `^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" } }] });
  if (!p) {
    const all = await c.projects.find({ orgId: ctx.org._id }).toArray();
    throw new ToolInputError(`Unknown project "${ref}". Projects: ${all.map((x) => `${x.key} (${x.name})`).join(", ")}.`);
  }
  return p;
}

/**
 * A status by name, stage or id, within ONE project's own statuses (VEC-115/116: a task only takes its own project's
 * statuses). A name only another project uses is refused with a message naming that project and listing this one's.
 * List filters use statusFilterIds instead.
 */
async function resolveStatus(ctx: McpCtx, ref: string, projectId: ObjectId) {
  return resolveProjectStatus(ctx.org._id, projectId, ref);
}

/** How flows work, said once in get_workspace / check_for_triage (VEC-176). */
const FLOWS_NOTE =
  "A project's `flow` lists, in order, who handles a task at each step (a bot, a person, any triage bot, whoever has it, or nobody), the status it sits in and the step's instructions. On a task with an active flow, the step's owner finishes its part with complete_task WITHOUT a status: Aimpoint moves the task to the next step's status and hands it to that step's owner (wakes the bot or notifies the person). Pass an earlier step's status to send it back; bots can't skip a required step. A wait step moves on with advance_task once what it waits for has happened. A task's own context (`flow` in get_task) says which step it's at and what to call. When triaging, assign a sub-task only if its step's owner shouldn't decide: an assignee you set wins over the flow.";

/** How the stages work, said once in get_workspace / check_for_triage (VEC-116). */
const STAGES_NOTE =
  'Statuses are per project: each project has its own ordered list (its `statuses`), and a task only takes a status of its own project, by that project\'s names. Every status has a stage, which is what Aimpoint acts on whatever the status is called: "backlog" (not planned yet: parked, so assigning a bot to it records the assignee only; it\'s held, not woken or handed out, until someone moves it to a not-started or started status), "triage" (waiting for a triage bot to break it down), "unstarted" (planned, not started; new tasks default to the first one), "started" (being worked on; a bot\'s pickup moves a not-started task to the first one, never a backlog one, and review statuses are started too), "done" (finished: releases the tasks waiting on it) and "cancelled" (dropped: also releases them).';

function parsePriority(v: unknown) {
  if (v === undefined || v === null || v === "") return undefined;
  const i = typeof v === "string" ? (PRIORITY_LABEL as readonly string[]).indexOf(v.toLowerCase()) : -1;
  const n = i >= 0 ? i : Number(v);
  if (![0, 1, 2, 3].includes(n)) throw new ToolInputError("`priority` is none, low, medium or high.");
  return n as 0 | 1 | 2 | 3;
}

function parseType(v: unknown) {
  if (v === undefined || v === null || v === "") return undefined;
  if (isTaskType(v)) return v;
  throw new ToolInputError('`type` is "issue", "feature" or "task".');
}

async function openStatusIds(orgId: ObjectId) {
  const c = await cols();
  return (await c.statuses.find({ orgId, category: { $nin: ["done", "cancelled"] } }, { projection: { _id: 1 } }).toArray()).map((s) => s._id);
}

/** Backlog-stage status ids: a task in one is parked unless its flow owns that step (VEC-274, isParked). */
async function backlogStatusIds(orgId: ObjectId) {
  const c = await cols();
  return new Set((await c.statuses.find({ orgId, category: "backlog" }, { projection: { _id: 1 } }).toArray()).map((s) => s._id.toHexString()));
}

/** The parked ones among `tasks` (hex ids). */
async function parkedIds(orgId: ObjectId, tasks: TaskDoc[]) {
  const backlog = await backlogStatusIds(orgId);
  const hits = await Promise.all(tasks.map(async (t) => (backlog.has(t.statusId.toHexString()) && (await isParked(t, "backlog")) ? t._id.toHexString() : null)));
  return new Set(hits.filter((x): x is string => !!x));
}

/** Assigned to this bot, open, unarchived, not stopped, but parked in Backlog: listed, never handed out. */
async function parkedAssignedCount(ctx: McpCtx) {
  const c = await cols();
  const backlog = [...(await backlogStatusIds(ctx.org._id))].map((id) => new ObjectId(id));
  if (!backlog.length) return 0;
  const tasks = await c.tasks.find({ orgId: ctx.org._id, assigneeId: ctx.bot._id, archivedAt: null, stopped: null, statusId: { $in: backlog } }, { projection: { description: 0 } }).limit(500).toArray();
  return (await parkedIds(ctx.org._id, tasks)).size;
}

/**
 * Assigned, open, unarchived tasks not yet picked up by this bot and ready to work on (every dependency done):
 * highest priority, then soonest due, then oldest. Parked ones (Backlog, VEC-274) are left out.
 */
async function unclaimedAssigned(ctx: McpCtx) {
  const c = await cols();
  const tasks = await c.tasks
    // A stopped task (VEC-216) is never handed out, also when the stop left no claim behind (a queued hand-off).
    .find({ orgId: ctx.org._id, assigneeId: ctx.bot._id, archivedAt: null, stopped: null, statusId: { $in: await openStatusIds(ctx.org._id) }, ...READY }, { projection: { description: 0 } })
    .limit(500)
    .toArray();
  const claimed = new Set(
    (await c.agentClaims.find({ botId: ctx.bot._id, taskId: { $in: tasks.map((t) => t._id) } }, { projection: { taskId: 1 } }).toArray()).map((x) => x.taskId.toHexString()),
  );
  const parked = await parkedIds(ctx.org._id, tasks);
  const due = (t: TaskDoc) => t.dueDate?.getTime() ?? Number.POSITIVE_INFINITY;
  return tasks
    .filter((t) => !claimed.has(t._id.toHexString()) && !parked.has(t._id.toHexString()))
    .sort((a, b) => b.priority - a.priority || due(a) - due(b) || a.createdAt.getTime() - b.createdAt.getTime());
}

/** Assigned to this bot, open, but still waiting on dependencies: not offered yet. */
async function blockedAssignedCount(ctx: McpCtx) {
  const c = await cols();
  return c.tasks.countDocuments({ orgId: ctx.org._id, assigneeId: ctx.bot._id, archivedAt: null, statusId: { $in: await openStatusIds(ctx.org._id) }, "waitingOn.0": { $exists: true } });
}

/**
 * Umbrellas this bot triaged that are ready, open and not yet handed to it for close-out (TaskDoc.closeout),
 * oldest request first. Re-triage clears `closeout`, and a task closed in the meantime drops out.
 */
async function closeoutFilter(ctx: McpCtx) {
  return {
    orgId: ctx.org._id,
    triagedBy: ctx.bot._id,
    "closeout.botId": ctx.bot._id,
    "closeout.deliveredAt": null,
    "closeout.resolvedAt": null,
    archivedAt: null,
    stopped: null,
    statusId: { $in: await openStatusIds(ctx.org._id) },
    ...READY,
  };
}

async function queueCounts(ctx: McpCtx) {
  const c = await cols();
  const [mentions, closeouts, assigned, blocked, parked] = await Promise.all([
    c.botMentions.countDocuments({ botId: ctx.bot._id, deliveredAt: null }),
    c.tasks.countDocuments(await closeoutFilter(ctx)),
    unclaimedAssigned(ctx),
    blockedAssignedCount(ctx),
    parkedAssignedCount(ctx),
  ]);
  return { unreadMentions: mentions, pendingCloseouts: closeouts, unstartedAssignedTasks: assigned.length, assignedWaitingOnDependencies: blocked, assignedParkedInBacklog: parked };
}

async function taskResult(ctx: McpCtx, task: TaskDoc, project: ProjectDoc, headline: string, opts: { includeImages?: boolean; highlight?: ObjectId[]; extra?: Record<string, unknown> } = {}) {
  const built = await buildTaskContext(task, project, { origin: ctx.origin, org: ctx.org, bot: ctx.bot, includeImages: opts.includeImages, highlight: opts.highlight });
  return { content: [text(headline), json({ ...opts.extra, task: built.data }), ...built.images] };
}

/** Rows for list views. */
async function summarise(ctx: McpCtx, tasks: TaskDoc[]) {
  const c = await cols();
  const [dir, statuses, projects, claims, waitingKeys] = await Promise.all([
    loadDirectory(ctx.org._id),
    c.statuses.find({ orgId: ctx.org._id }).toArray(),
    c.projects.find({ orgId: ctx.org._id }).toArray(),
    c.agentClaims.find({ botId: ctx.bot._id, taskId: { $in: tasks.map((t) => t._id) } }).toArray(),
    taskKeys(ctx.org._id, tasks.flatMap((t) => t.waitingOn ?? [])),
  ]);
  const st = new Map(statuses.map((s) => [s._id.toHexString(), s.name]));
  const pk = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
  const cl = new Map(claims.map((x) => [x.taskId.toHexString(), x.state]));
  const parked = await parkedIds(ctx.org._id, tasks);
  return tasks.map((t) => {
    const key = `${pk.get(t.projectId.toHexString()) ?? "?"}-${t.number}`;
    const isParkedTask = parked.has(t._id.toHexString());
    return {
      key,
      title: t.title,
      type: t.type,
      status: st.get(t.statusId.toHexString()) ?? null,
      priority: PRIORITY_LABEL[t.priority],
      assignee: t.assigneeId ? personName(dir, t.assigneeId) : null,
      dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
      archived: !!t.archivedAt,
      /** False while a task it depends on isn't done yet (`waitingOn` lists those) or while it's parked in Backlog. */
      ready: !t.waitingOn?.length && !isParkedTask,
      waitingOn: (t.waitingOn ?? []).map((id) => waitingKeys.get(id.toHexString()) ?? "a deleted task"),
      /** Parked in a backlog-stage status (VEC-274): not work yet, check_for_work won't hand it out. */
      ...(isParkedTask ? { parked: true, notReadyReason: parkedReason(st.get(t.statusId.toHexString()) ?? "Backlog") } : {}),
      yourState: cl.get(t._id.toHexString()) ?? null,
      updatedAt: t.updatedAt.toISOString(),
      url: taskUrl(ctx.origin, ctx.org, key),
    };
  });
}

/** Projects (with their context and their own statuses in workflow order), and people and bots: what get_workspace returns. */
async function workspaceSummary(ctx: McpCtx) {
  const c = await cols();
  const [projects, statuses, dir, flows] = await Promise.all([
    c.projects.find({ orgId: ctx.org._id }).sort({ createdAt: 1 }).toArray(),
    c.statuses.find({ orgId: ctx.org._id }).sort({ order: 1 }).toArray(),
    loadDirectory(ctx.org._id),
    botOrgFlows(ctx.org._id),
  ]);
  const byProject = groupStatusesByProject(statuses);
  const newTasks = await botNewTaskViews(ctx.org._id, projects, byProject);
  return {
    organisation: { id: ctx.org._id.toHexString(), name: ctx.org.name, slug: ctx.org.slug },
    statusStages: STAGES_NOTE,
    projects: projects.map((p) => ({
      id: p._id.toHexString(),
      key: p.key,
      name: p.name,
      archived: !!p.archivedAt,
      context: projectContext(p),
      /** This project's statuses in workflow order. Tasks in this project only take these names. */
      statuses: (byProject.get(p._id.toHexString()) ?? []).map((s) => ({ id: s._id.toHexString(), name: s.name, stage: s.category })),
      /**
       * This project's resolved flow (VEC-176): who handles a task at each step, in order (owner, status, instructions,
       * how it moves on). Null = flows are off for it. `active` false = no step names an owner or instructions.
       */
      flow: flows.get(p._id.toHexString()) ?? null,
      /**
       * Where a person's new task with no status lands in this project (VEC-190): `source` "project" = the project's
       * own override, "org" = the org default stage, "fallback" = its first not-started status. Read-only here.
       */
      newTasks: newTasks.get(p._id.toHexString()) ?? null,
    })),
    newTasks: NEW_TASKS_NOTE,
    flows: FLOWS_NOTE,
    // Disabled bots (VEC-344) aren't offered: they can't be assigned or woken. The directory still names them.
    people: listedToAgents([...dir.values()]),
  };
}

/** Unarchived tasks in a Triage-stage status that no bot is triaging (or has triaged), oldest first. */
async function triageQueue(ctx: McpCtx) {
  const c = await cols();
  const ids = (await c.statuses.find({ orgId: ctx.org._id, category: "triage" }, { projection: { _id: 1 } }).toArray()).map((s) => s._id);
  if (!ids.length) return { hasTriage: false, tasks: [] as TaskDoc[] };
  const tasks = await c.tasks.find({ orgId: ctx.org._id, archivedAt: null, stopped: null, statusId: { $in: ids } }, { projection: { description: 0 } }).sort({ createdAt: 1 }).limit(500).toArray();
  const taken = new Set(
    (await c.agentClaims.find({ kind: "triage", taskId: { $in: tasks.map((t) => t._id) } }, { projection: { taskId: 1 } }).toArray()).map((x) => x.taskId.toHexString()),
  );
  return { hasTriage: true, tasks: (tasks as TaskDoc[]).filter((t) => !taken.has(t._id.toHexString())) };
}

/* ---------------- tools ---------------- */

/** The ids among `ids` whose task is still open (not done or cancelled, per its status's stage). */
async function openDeps(orgId: ObjectId, ids: ObjectId[]): Promise<ObjectId[]> {
  if (!ids.length) return [];
  const c = await cols();
  const deps = await c.tasks.find({ orgId, _id: { $in: ids } }, { projection: { statusId: 1 } }).toArray();
  const closed = new Set(
    (await c.statuses.find({ _id: { $in: deps.map((d) => d.statusId) } }, { projection: { category: 1 } }).toArray())
      .filter((s) => isClosedCategory(s.category))
      .map((s) => s._id.toHexString()),
  );
  return deps.filter((d) => !closed.has(d.statusId.toHexString())).map((d) => d._id);
}

/**
 * A bot finished its work on a task but left it in an open status (e.g. In Review) while other tasks wait
 * on it. They stay blocked until someone closes it, and no bot is working on it any more, so make sure a
 * person hears about it: the people the closing comment @mentioned (already notified), else the task's
 * creator when that's a person, else the organisation's admins. Returns a note for the tool reply, or "".
 * Not when the task is itself waiting on open dependencies (the bot parked it behind them): that isn't a
 * stall, and the task is handed on again when they close (VEC-90), so the reply only says so.
 */
/**
 * complete_task without a status on a flow task (VEC-175): the step to hand it to, when this bot may move the task
 * (its assignee, creator, or triager right now). Null when there's no flow step to advance from.
 */
async function flowAdvanceFor(ctx: McpCtx, task: TaskDoc, triaging: boolean, requested?: StatusDoc | null): Promise<AdvanceTarget | null> {
  const access = taskAccess({ createdBy: task.createdBy.toHexString(), assigneeId: task.assigneeId?.toHexString() ?? null }, ctx.bot._id.toHexString(), false);
  const t = await advanceTarget(task, requested);
  // A wait step moves nothing either way, so anyone finishing there is told how it moves on (advance_task).
  if (t.kind === "wait") return t;
  if (access === "comment" && !triaging) {
    // Not its assignee or creator: the flow isn't this bot's to move. Say so rather than going quiet (VEC-315).
    return t.kind === "advance" && !requested ? { kind: "none", why: `you're not its assignee or creator, so the flow didn't move it on to ${t.to.name}` } : null;
  }
  return t.kind === "none" && !t.why ? null : t;
}

/** What the flow did, for the complete_task reply: " Moved to In Review and handed to Testing Verification for Test." */
async function flowReplyNote(ctx: McpCtx, taskId: ObjectId, step: AdvanceTarget): Promise<string> {
  if (step.kind === "none") return step.why ? ` Nothing moved: ${step.why}.` : "";
  if (step.kind === "wait") return ` It's at the ${step.step.name} step, which waits for "${step.step.wait?.label ?? "an outside event"}"; it moves on when that happens (advance_task, or a person moves it), not on complete_task.`;
  const c = await cols();
  const after = await c.tasks.findOne({ _id: taskId }, { projection: { assigneeId: 1, flow: 1, waitingOn: 1, triagedBy: 1 } });
  if (after?.flow?.paused) return pausedMoveNote(pausedAsUmbrella(after.flow, { waiting: !!after.waitingOn?.length, triaged: !!after.triagedBy }), step.to.status.name);
  const owner = after?.assigneeId ? ((await loadDirectory(ctx.org._id)).get(after.assigneeId.toHexString())?.name ?? "its owner") : null;
  const self = after?.assigneeId?.equals(ctx.bot._id);
  if (step.to.status.category === "done") return ` The flow closed it as ${step.to.status.name}.`;
  return ` Moved to ${step.to.status.name} for the ${step.to.name} step${owner ? (self ? " (you own that step too: you'll be handed it again)" : ` and handed to ${owner}`) : ", with nobody assigned"}.`;
}

/** " It's in In Review (the Test step of its flow), assigned to Tester." for tool replies (VEC-176). */
async function whereNow(ctx: McpCtx, taskId: ObjectId): Promise<string> {
  const c = await cols();
  const t = await c.tasks.findOne({ _id: taskId });
  if (!t) return "";
  const [st, dir, flow] = await Promise.all([c.statuses.findOne({ _id: t.statusId }, { projection: { name: 1 } }), loadDirectory(ctx.org._id), t.flow?.paused ? null : loadTaskFlow(t)]);
  const step = flow?.current && flow.status ? ` (the ${flow.current.name} step of its flow)` : "";
  const who = t.assigneeId ? (t.assigneeId.equals(ctx.bot._id) ? "assigned to you" : `assigned to ${personName(dir, t.assigneeId)}`) : "with nobody assigned";
  return ` It's in ${st?.name ?? "its status"}${step}, ${who}.`;
}

/** The task sits on a flow step that someone other than `botId` now owns (VEC-175). */
async function handedOnByFlow(taskId: ObjectId, botId: ObjectId): Promise<boolean> {
  const t = await (await cols()).tasks.findOne({ _id: taskId }, { projection: { flow: 1, assigneeId: 1 } });
  return !!t?.flow?.stepId && !t.flow.paused && !!t.assigneeId && !t.assigneeId.equals(botId);
}

async function reviewHandoff(ctx: McpCtx, taskId: ObjectId, key: string, comment: string | undefined | null): Promise<string> {
  const c = await cols();
  const orgId = ctx.org._id;
  const task = await c.tasks.findOne({ _id: taskId, orgId }, { projection: { statusId: 1, createdBy: 1, archivedAt: 1, waitingOn: 1, assigneeId: 1 } });
  if (!task || task.archivedAt) return "";
  const st = await c.statuses.findOne({ _id: task.statusId }, { projection: { category: 1, name: 1, projectId: 1 } });
  if (!st || isClosedCategory(st.category)) return "";
  const blocked = await c.tasks.find({ orgId, waitingOn: taskId, archivedAt: null }, { projection: { _id: 1 } }).toArray();
  if (!blocked.length) return "";
  const ownDeps = await openDeps(orgId, task.waitingOn ?? []);
  if (ownDeps.length) {
    const depKeys = [...(await taskKeys(orgId, ownDeps)).values()].sort();
    const back = task.assigneeId?.equals(ctx.bot._id) ? "you'll be handed it back" : "it becomes ready again";
    return ` ${key} is waiting on ${depKeys.join(", ")}; ${back} when ${depKeys.length === 1 ? "it closes" : "they close"}.`;
  }
  const keys = [...(await taskKeys(orgId, blocked.map((b) => b._id))).values()].sort();
  const waiting = `${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} still waiting on ${key}`;
  const dir = await loadDirectory(orgId);
  const names = (ids: ObjectId[]) => ids.map((id) => dir.get(id.toHexString())?.name ?? id.toHexString()).join(", ");

  const mentionIds = [...new Set([...(comment ?? "").matchAll(/<@([a-f0-9]{24})>/g)].map((m) => m[1]))].map((id) => new ObjectId(id));
  const mentioned = mentionIds.length
    ? (await c.memberships.find({ orgId, userId: { $in: mentionIds } }, { projection: { userId: 1 } }).toArray()).map((m) => m.userId)
    : [];
  let notified = mentioned;
  if (!mentioned.length) {
    const creator = await c.memberships.findOne({ orgId, userId: task.createdBy }, { projection: { userId: 1 } });
    notified = creator ? [creator.userId] : (await c.memberships.find({ orgId, role: "admin" }, { projection: { userId: 1 } }).toArray()).map((m) => m.userId);
    await notify(orgId, notified, { kind: "review", taskId, actorId: ctx.bot._id, detail: `${st.name}: ${waiting}` });
  }
  const who = notified.length
    ? ` ${names(notified)} ${mentioned.length ? "got your mention" : notified.length === 1 ? "has been notified" : "have been notified"} to review it.`
    : " No person could be notified, so nobody will pick this up.";
  const w = await loadStatusWords(orgId, st.projectId);
  return ` Note: ${st.name} isn't a closing status, so ${waiting} until it's moved to ${w.done} (or ${w.cancelled}).${who} If the work already meets its acceptance criteria, move ${key} to ${w.done} with set_status instead.`;
}

const TOOLS: Record<string, ToolImpl> = {
  check_for_work: {
    description:
      "\"Do I have a task?\" Call this on your schedule. Returns ONE item, most urgent first: (1) a comment that newly @mentioned you, with the full task and comment thread so you can reply (if you're the task's assignee and it's open, the mention hands the work back: it's picked up by you again and moved back to its project's first started status, if it has one (on a flow step, the status the flow keeps it in), so finish it with complete_task again: without a status on an active flow); (2) a task you triaged whose sub-tasks are all done (`kind: \"closeout\"`): summarise what they delivered on it and close it out with complete_task; or (3) the next task assigned to you that you haven't picked up and that is ready (every task it depends on is done), which is then marked as picked up by you and moved for you to its project's first started-stage status (In Progress by default; only from a not-started or other started status such as In Review, never from Backlog; a project with no started status leaves it where it is). Tasks still waiting on dependencies are held back until they're ready. Tasks in a backlog-stage status (Backlog) are parked, not work: they're held, not handed out (list_my_tasks shows them as `parked`), until someone moves them to a not-started or started status such as Todo, which hands them to you. Returns `kind: \"idle\"` when there's nothing new. Call again to get the next item.",
    inputSchema: { type: "object", properties: { include_images: IMAGES_ARG }, additionalProperties: false },
    run: async (args, ctx) => {
      const c = await cols();
      const includeImages = bool(args, "include_images", true);
      // 1. New mentions, oldest first, one task at a time.
      for (let guard = 0; guard < 50; guard++) {
        const now = new Date();
        const first = await c.botMentions.findOneAndUpdate(
          { botId: ctx.bot._id, deliveredAt: null },
          { $set: { deliveredAt: now } },
          { sort: { createdAt: 1 }, returnDocument: "after" },
        );
        if (!first) break;
        const rest = await c.botMentions.find({ botId: ctx.bot._id, taskId: first.taskId, deliveredAt: null }).toArray();
        if (rest.length) await c.botMentions.updateMany({ _id: { $in: rest.map((r) => r._id) } }, { $set: { deliveredAt: now } });
        const task = await c.tasks.findOne({ _id: first.taskId, orgId: ctx.org._id });
        const project = task && (await c.projects.findOne({ _id: task.projectId }));
        if (!task || !project) continue;
        const commentIds = [first, ...rest].map((m) => m.commentId);
        const [mentionComments, dir] = await Promise.all([c.comments.find({ _id: { $in: commentIds } }).sort({ createdAt: 1 }).toArray(), loadDirectory(ctx.org._id)]);
        const quote = mentionComments
          .map((cm) => `> ${personName(dir, cm.authorId, "Someone")}: ${cm.body.replace(/<@([a-f0-9]{24})>/g, (_, id: string) => `@${personName(dir, id, "former member")}`).replace(/\n/g, "\n> ")}`)
          .join("\n\n");
        const key = `${project.key}-${task.number}`;
        // A mention of the assignee hands the work back: claim in progress, In Review -> In Progress, Stalled clears.
        const resumed = await resumeOnMention(ctx.org._id, ctx.bot._id, task._id);
        const fresh = resumed ? ((await c.tasks.findOne({ _id: task._id })) ?? task) : task;
        const w = await loadStatusWords(ctx.org._id, fresh.projectId);
        const stoppedNote = fresh.stopped?.botId.equals(ctx.bot._id)
          ? ` ${(await loadDirectory(ctx.org._id)).get(fresh.stopped.by.toHexString())?.name ?? "A person"} has stopped your work on ${key} (see \`stopped\`), so answer the comment and nothing more: don't carry on with the task. It's handed back to you if they resume it.`
          : "";
        // On an active-flow step the pickup followed the flow (it may have stayed put) and finishing hands it on (VEC-317).
        const resumedFlow = resumed ? await flowBriefing(fresh, project.key) : null;
        const nowIn = resumed ? ((await c.statuses.findOne({ _id: fresh.statusId, orgId: ctx.org._id }, { projection: { name: 1 } }))?.name ?? "its current status") : "";
        const resumeNote = resumed
          ? ` You're its assignee, so this hands the work back to you: it's picked up by you again and ${
              resumedFlow ? `it's in ${nowIn} for its ${resumedFlow.payload.step.name} step (no need to set that yourself)` : w.started ? `Aimpoint moved it back to ${w.started} (no need to set that yourself)` : `it stays in ${nowIn}, since this project has no started status`
            }. Do what the comment asks, then ${
              resumedFlow
                ? `finish the step again: ${resumedFlow.finish.charAt(0).toLowerCase() + resumedFlow.finish.slice(1)}`
                : `finish with complete_task again: ${w.done} when the work meets its acceptance criteria (that releases the tasks waiting on it), or ${reviewWord(w)} only when a named person must check something, with a <@id> mention of them in the comment.`
            } ${BLOCKER_NOTE}\n\n${PROGRESS_HINT}${flowLastNote(resumedFlow)}`
          : "";
        return taskResult(
          ctx,
          fresh,
          project,
          `You've been mentioned in a comment on ${key} "${task.title}" (project ${project.name}).\n\n${quote}\n\nRead the task and the whole thread below, then respond with add_comment (task "${key}"). The comments marked "new": true are the ones that mentioned you.${stoppedNote}${resumeNote}`,
          { includeImages, highlight: commentIds, extra: { kind: "mention", resumed, mentionCommentIds: commentIds.map((id) => id.toHexString()), queue: await queueCounts(ctx) } },
        );
      }

      // 2. Umbrellas this bot triaged, now ready to close out. Marked delivered atomically, so each is handed out once.
      for (let guard = 0; guard < 50; guard++) {
        const t = await c.tasks.findOneAndUpdate(
          await closeoutFilter(ctx),
          { $set: { "closeout.deliveredAt": new Date() } },
          { sort: { "closeout.requestedAt": 1 }, returnDocument: "after", projection: { description: 0 } },
        );
        if (!t) break;
        const task = await c.tasks.findOne({ _id: t._id });
        const project = task && (await c.projects.findOne({ _id: task.projectId }));
        if (!task || !project) continue;
        const key = `${project.key}-${task.number}`;
        return taskResult(
          ctx,
          task,
          project,
          `${key} "${task.title}" in project ${project.name} is ready to close out: everything it depends on is done. You triaged it, so wrapping it up is yours:\n\n${CLOSEOUT_STEPS(key, await loadStatusWords(ctx.org._id, task.projectId))}`,
          { includeImages, extra: { kind: "closeout", queue: await queueCounts(ctx) } },
        );
      }

      // 3. Assigned tasks not yet picked up.
      for (const t of await unclaimedAssigned(ctx)) {
        // A wait step (design 5.7, VEC-181): told once with the wait instructions, then done, so the bot isn't shown as
        // working while the task waits and this loop never offers it again.
        const waiting = await atWaitStep(t);
        const now = new Date();
        const claimId = new ObjectId();
        try {
          await c.agentClaims.insertOne({ _id: claimId, orgId: ctx.org._id, botId: ctx.bot._id, taskId: t._id, state: waiting ? "done" : "in_progress", claimedAt: now, finishedAt: waiting ? now : null });
        } catch (err) {
          if ((err as { code?: number }).code === 11000) continue; // another run picked it up
          throw err;
        }
        // The status follows the work (Todo / In Review -> In Progress). That broadcast carries the claim too.
        const moved = waiting ? false : await markStartedByBot(ctx.org._id, ctx.bot._id, t._id);
        if (!moved && !waiting) await publishWorking(ctx.org._id, ctx.bot._id, [t._id]);
        const task = await c.tasks.findOne({ _id: t._id });
        const project = task && (await c.projects.findOne({ _id: task.projectId }));
        if (!task || !project) continue;
        const key = `${project.key}-${task.number}`;
        const w = await loadStatusWords(ctx.org._id, task.projectId);
        const deps = task.dependsOn?.length ? ` Everything it depends on is done (see \`dependencies.dependsOn\`); their comments may hold results you need.` : "";
        // A flow step (VEC-175): its instructions and how to hand it on replace the generic finishing advice.
        const flow = await flowBriefing(task, project.key);
        const finish = flow
          ? ` ${flow.text}`
          : ` Finish with ${w.done} when the work meets its acceptance criteria: only a done status releases the tasks waiting on it. Use ${reviewWord(w)} only when a named person must check or decide something, and @mention them.`;
        const queue = await queueCounts(ctx);
        return taskResult(
          ctx,
          task,
          project,
          `You have a task: ${key} "${task.title}" in project ${project.name}, assigned to you.${deps}${
            waiting
              ? ` It's waiting at a flow step, so Aimpoint doesn't count you as working on it: watch for what it waits for and move it on with advance_task when that happens.`
              : `${moved ? ` It's now picked up by you, and Aimpoint moved it to ${(await c.statuses.findOne({ _id: task.statusId }, { projection: { name: 1 } }))?.name ?? w.started ?? "a started status"} for you (no need to set that yourself).` : ` It's now picked up by you.`} Work on it and call complete_task when you're done (or release_task to hand it back).`
          }${finish} Statuses are per project: use ${project.key}'s names (\`project.statuses\` below). ${BLOCKER_NOTE} ${STOP_NOTE}\n\n${PROGRESS_HINT}${waiting ? "" : flowLastNote(flow)}`,
          { includeImages, extra: { kind: "assigned", ...(waiting ? { waiting: true } : {}), queue, ...(flow ? { flow: flow.payload } : {}) } },
        );
      }

      // 4. Nothing new.
      const inProgress = await c.agentClaims.find({ botId: ctx.bot._id, state: "in_progress", kind: { $ne: "triage" } }).sort({ claimedAt: 1 }).limit(50).toArray();
      // Only open tasks: a closed one has nothing left to do, even if a claim on it was left behind.
      const tasks = await c.tasks.find({ _id: { $in: inProgress.map((x) => x.taskId) }, statusId: { $in: await openStatusIds(ctx.org._id) } }, { projection: { description: 0 } }).toArray();
      const rows = await summarise(ctx, tasks as TaskDoc[]);
      const blocked = await blockedAssignedCount(ctx);
      const parkedCount = await parkedAssignedCount(ctx);
      const waitNote =
        (blocked ? ` ${blocked} task${blocked === 1 ? " is" : "s are"} assigned to you but waiting on other tasks to be done; ${blocked === 1 ? "it" : "they"}'ll come through here once ready.` : "") +
        (parkedCount ? ` ${parkedCount} task${parkedCount === 1 ? " is" : "s are"} assigned to you but parked in Backlog: not work yet, so leave ${parkedCount === 1 ? "it" : "them"} alone until someone moves ${parkedCount === 1 ? "it" : "them"} to a not-started or started status.` : "");
      return {
        content: [
          text(
            (rows.length ? `No new work. You still have ${rows.length} task${rows.length === 1 ? "" : "s"} picked up and not finished.` : blocked || parkedCount ? "No new work." : "No new work. Nothing is assigned to you and nobody has mentioned you.") + waitNote,
          ),
          json({ kind: "idle", stillInProgress: rows, assignedWaitingOnDependencies: blocked, assignedParkedInBacklog: parkedCount }),
        ],
      };
    },
  },

  check_for_triage: {
    description:
      "\"Is there anything to triage?\" Returns ONE task waiting in a Triage status (oldest first) that no other bot is triaging, with its full context and the workspace (projects with their own statuses, people and bots), and marks it as being triaged by you so no other bot is handed it. Your job is to break it into the concrete tasks needed to deliver it, created with create_task and chained with `depends_on` so the work happens in a logical order, then make the original task depend on them and move it out of Triage with complete_task. You stay its triager: when the tasks it depends on are all done, you're called back (a push wake-up, or `kind: \"closeout\"` on check_for_work) to summarise what was delivered and close it out. While you triage it you can edit it like its creator (not archive it). release_task hands it back. Returns `kind: \"idle\"` when nothing is waiting.",
    inputSchema: { type: "object", properties: { include_images: IMAGES_ARG }, additionalProperties: false },
    run: async (args, ctx) => {
      const c = await cols();
      const { hasTriage, tasks } = await triageQueue(ctx);
      if (!hasTriage) {
        return {
          content: [
            text("No project in this organisation has a triage-stage status, so there's nothing to triage. An admin can add one to a project under Settings → Statuses with the Triage stage."),
            json({ kind: "idle", waitingInTriage: 0 }),
          ],
        };
      }
      for (const [i, t] of tasks.entries()) {
        const claimId = new ObjectId();
        try {
          await c.agentClaims.insertOne({ _id: claimId, orgId: ctx.org._id, botId: ctx.bot._id, taskId: t._id, kind: "triage", state: "in_progress", claimedAt: new Date(), finishedAt: null });
        } catch (err) {
          if ((err as { code?: number }).code === 11000) continue; // another bot took it, or you already hold a claim on it
          throw err;
        }
        await publishWorking(ctx.org._id, ctx.bot._id, [t._id]);
        const task = await c.tasks.findOne({ _id: t._id });
        const project = task && (await c.projects.findOne({ _id: task.projectId }));
        if (!task || !project) continue;
        const key = `${project.key}-${task.number}`;
        return taskResult(
          ctx,
          task,
          project,
          `Triage ${key} "${task.title}" in project ${project.name}. It's now being triaged by you; no other bot will be handed it. Break it down into the actual tasks needed to do the job and wire up their dependencies so the work happens in a logical order:\n\n${TRIAGE_STEPS(key, await loadStatusWords(ctx.org._id, task.projectId))}\n\n${STOP_NOTE}`,
          { includeImages: bool(args, "include_images", true), extra: { kind: "triage", waitingInTriage: tasks.length - i - 1, workspace: await workspaceSummary(ctx) } },
        );
      }
      const mine = await c.agentClaims.find({ botId: ctx.bot._id, kind: "triage", state: "in_progress" }).sort({ claimedAt: 1 }).limit(50).toArray();
      const rows = mine.length ? await summarise(ctx, (await c.tasks.find({ _id: { $in: mine.map((x) => x.taskId) } }, { projection: { description: 0 } }).toArray()) as TaskDoc[]) : [];
      return {
        content: [
          text(
            rows.length
              ? `Nothing new in Triage. You're still triaging ${rows.map((r) => r.key).join(", ")}: finish with complete_task (with a status that moves it out of Triage) or hand it back with release_task.`
              : "Nothing is waiting in Triage.",
          ),
          json({ kind: "idle", waitingInTriage: 0, stillTriaging: rows }),
        ],
      };
    },
  },

  list_my_tasks: {
    readOnly: true,
    description:
      "Open tasks assigned to you, plus tasks you've picked up and not finished. `yourState` is in_progress, done or null (not picked up yet). `ready` is false while a task it depends on isn't done (`waitingOn` lists them); check_for_work offers those once they're ready. A task in a backlog-stage status (Backlog) is `parked: true` with `ready: false` and a `notReadyReason`: it's not work yet: it's held, and check_for_work won't offer it until someone moves it to a not-started or started status (such as Todo). Tasks a person stopped your work on are listed apart under `stopped` (who, when): don't work on them; they're handed back to you if they're resumed.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async (_args, ctx) => {
      const c = await cols();
      const claims = await c.agentClaims.find({ botId: ctx.bot._id, state: "in_progress" }, { projection: { taskId: 1 } }).toArray();
      const tasks = await c.tasks
        .find(
          { orgId: ctx.org._id, $or: [{ assigneeId: ctx.bot._id, archivedAt: null, statusId: { $in: await openStatusIds(ctx.org._id) } }, { _id: { $in: claims.map((x) => x.taskId) } }] },
          { projection: { description: 0 } },
        )
        .sort({ priority: -1, updatedAt: -1 })
        .limit(200)
        .toArray();
      // Stopped by a person (VEC-216): not work to do, so listed apart with who stopped it and when.
      const mine = (t: TaskDoc) => !!t.stopped?.botId.equals(ctx.bot._id);
      const stoppedRows = await summarise(ctx, (tasks as TaskDoc[]).filter(mine));
      const dir = stoppedRows.length ? await loadDirectory(ctx.org._id) : null;
      const stopInfo = new Map((tasks as TaskDoc[]).filter(mine).map((t) => [t._id.toHexString(), t.stopped!]));
      const stopped = (tasks as TaskDoc[]).filter(mine).map((t, i) => {
        const s = stopInfo.get(t._id.toHexString())!;
        return { ...stoppedRows[i], stoppedBy: personName(dir!, s.by), stoppedAt: s.at.toISOString(), stoppedWork: s.kind };
      });
      return { content: [json({ tasks: await summarise(ctx, (tasks as TaskDoc[]).filter((t) => !mine(t))), ...(stopped.length ? { stopped } : {}) })] };
    },
  },

  complete_task: {
    description:
      "Say you've finished your work on a task. Optionally post a final comment and move it to a status. On a task whose project has an active flow (its context's `flow.active` is true; `flow.howToFinish` says what to do), omit `status` to hand it on: Aimpoint moves it to the next step's status and assigns that step's owner (waking the bot or notifying the person, with the step's instructions; when you own the next step too, you're handed it again), or closes it if the next step is Done; the reply says where it went and who has it now. Passing the step's own status, a working status such as In Progress, or the next step's status counts as done with your step and hands it on the same way. Pass an earlier step's status to send it back (say what failed in the comment); a bot can't skip a required later step, Done included, and a refused status leaves you on the step as before. Calling this is the only way a step ends: saying you're done in a comment or in your run's last message moves nothing, and the task sits at the step. A wait step doesn't move on with complete_task: use advance_task once what it waits for has happened. Without an active flow, omitting `status` moves nothing. (When you picked the task up, Aimpoint already moved it to a started status for you, so pass the status it should end in.) Statuses are per project: pass a name from the task's own project (\`project.statuses\` in get_task, or get_workspace); the default names are used below, and a project may have renamed them. Use Done (a done-stage status) when the work meets its acceptance criteria: only a done (or cancelled) status releases the tasks that depend on it. In Review (an open status) leaves them waiting until a person closes it, so use it only when a person really has to check or decide something, and @mention that person in the comment. The task won't be offered again by check_for_work unless someone assigns it to you afresh (a flow hand-off back to you counts). Mentions on it still reach you. For a task you're triaging, this ends the triage: pass a `status` that moves it out of Triage. You stay its triager afterwards: once everything it depends on is done you're called back (push wake-up, or `kind: \"closeout\"` on check_for_work) and close it out with complete_task and a closing status (e.g. Done, or In Review if something was cancelled or left open).",
    inputSchema: {
      type: "object",
      properties: {
        task: TASK_ARG,
        comment: { type: "string", description: "Optional closing comment, e.g. a summary of what you did. Mention people with <@id>." },
        status: {
          type: "string",
          description:
            "Optional status name (or stage) of the task's own project to move it to (needs you to be its creator or assignee; as its triager, a closing status once it's ready). A name only another project has is refused. Leave it out on a task with an active flow to hand it to the next step (its own, a working or the next step's status does the same; an earlier step's status sends it back).",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const { task, project } = await findTask(ctx, str(args, "task", true)!);
      const status = str(args, "status");
      const comment = str(args, "comment");
      const c = await cols();
      const now = new Date();
      const claim = await c.agentClaims.findOne({ botId: ctx.bot._id, taskId: task._id });
      const triageClaim = claim?.kind === "triage";
      // Resolved before anything changes, so a bad name leaves the claim and comments as they were.
      const requested = status ? await resolveStatus(ctx, status, task.projectId) : null;
      // Without a status, a task on a flow step is handed to the next step (VEC-175). With one that only means
      // "done with my step" (the step's own status, a working status, the next step's), it's handed on the same way;
      // any other status (an earlier step's, Done, Cancelled, a jump) is applied as given (VEC-315).
      const step = requested && triageClaim ? null : await flowAdvanceFor(ctx, task, triageClaim, requested);
      const advancing = step?.kind === "advance";
      if (!triageClaim) {
        // Finish this bot's round first, so a flow hand-off back to the same bot (it owns the next step too) can start
        // a fresh one, and the move's broadcast already shows the working ring cleared.
        await c.agentClaims.updateOne(
          { botId: ctx.bot._id, taskId: task._id },
          { $set: { state: "done", finishedAt: now }, $setOnInsert: { _id: new ObjectId(), orgId: ctx.org._id, claimedAt: now } },
          { upsert: true },
        );
        if (comment) await addCommentAs(ctx.actor, task._id, comment);
      }
      const moved =
        step?.kind === "advance"
          ? await updateTaskAs(ctx.actor, task._id, step.statusChanges ? { statusId: step.to.status.id } : {}, { flowTo: step.to.id })
          : requested
            ? await updateTaskAs(ctx.actor, task._id, { statusId: requested._id.toHexString() }).catch(async (err) => {
                // Refused (e.g. a required step can't be skipped): nothing moved, so the bot is still on its step. Put
                // its claim back as it was, or the task would sit as finished Stalled with nobody on it (VEC-315).
                if (!triageClaim) {
                  if (claim) await c.agentClaims.updateOne({ _id: claim._id }, { $set: { state: claim.state, finishedAt: claim.finishedAt ?? null } });
                  else await c.agentClaims.deleteOne({ botId: ctx.bot._id, taskId: task._id, kind: { $ne: "triage" } });
                }
                throw err;
              })
            : null;
      const flowNote = step ? await flowReplyNote(ctx, task._id, step) : "";
      // The status the bot passed, and what became of it.
      const statusNote = !requested
        ? ""
        : advancing
          ? ` You passed ${requested.name}, which ${
              requested._id.equals(step.to.status.id) ? "is the next step's status" : requested._id.equals(step.from.status.id) ? "is this step's own status" : "is a working status, not a step"
            }, so it was handed on as complete_task without a status does.`
          : ` Moved to ${requested.name}.`;
      if (triageClaim && comment) await addCommentAs(ctx.actor, task._id, comment);
      if (claim?.kind === "triage") {
        const after = await c.tasks.findOne({ _id: task._id }, { projection: { statusId: 1 } });
        const st = after && (await c.statuses.findOne({ _id: after.statusId }, { projection: { category: 1, name: 1 } }));
        const key = `${project.key}-${task.number}`;
        // Triage is finished either way: this bot now owns closing the task out once its sub-tasks are done.
        await recordTriagedBy(task._id, ctx.bot._id);
        if (st?.category === "triage") {
          // Still in Triage: keep a finished claim so it isn't offered for triage again.
          await c.agentClaims.updateOne({ _id: claim._id }, { $set: { state: "done", finishedAt: now } });
          if (claim.state === "in_progress") await publishWorking(ctx.org._id, ctx.bot._id, [task._id]);
          return {
            content: [
              text(`Finished triaging ${key}, but it's still in ${st.name}, so it won't be offered for triage again until someone moves it out and back. Move it on with set_status if that wasn't intended.`),
            ],
          };
        }
        // Out of Triage: the triage is over. Drop the claim so the task is ordinary work again (also for you, if you assigned it to yourself).
        await c.agentClaims.deleteOne({ _id: claim._id });
        if (claim.state === "in_progress") await publishWorking(ctx.org._id, ctx.bot._id, [task._id]);
        // Where it went and who has it (VEC-315: a triager that assigned itself is handed the next step now).
        const where = step?.kind === "advance" ? "" : await whereNow(ctx, task._id);
        return { content: [text(`Finished triaging ${key}.${statusNote}${flowNote}${where}${comment ? " Comment posted." : ""}`)] };
      }
      // Finishing is also the end of its close-out, if one was pending: the task can show as "finished" Stalled now (VEC-89).
      const resolved = await resolveCloseout(task._id, ctx.bot._id);
      // A new done claim (none before, or in progress) can also make it Stalled, so republish then as well.
      if (claim?.state !== "done" || claim?.unfinishedAt || resolved) await publishWorking(ctx.org._id, ctx.bot._id, [task._id]);
      const key = `${project.key}-${task.number}`;
      // A flow hand-off gave the task its next owner (an advance, or an explicit status that sent it to another step's
      // owner, e.g. a tester failing it back to Develop): nothing is left waiting on this bot, so no review note.
      // At a wait step nothing is left for a reviewer either: it moves on with advance_task (VEC-181).
      const handoff = advancing || step?.kind === "wait" || (moved && (await handedOnByFlow(task._id, ctx.bot._id))) ? "" : await reviewHandoff(ctx, task._id, key, comment);
      // Parked behind open dependencies nobody owns (the status didn't change, or no status was given): take them (VEC-107).
      const owned = [...assignedBlockersOf(moved), ...(await ownUnownedBlockers(ctx.actor, task._id))];
      // Where it is now and who has it (VEC-176), unless the flow note already said so.
      const where = advancing ? "" : await whereNow(ctx, task._id);
      return { content: [text(`Marked your work on ${key} as finished.${statusNote}${flowNote}${where}${comment ? " Comment posted." : ""}${handoff}${blockersNote(owned)}`)] };
    },
  },

  release_task: {
    description:
      "Hand a task you picked up back. It will be offered again on the next check_for_work while it's still assigned to you; reassign it with assign_task if someone else should take it. For a task you're triaging, it goes back in the triage queue for another check_for_triage.",
    inputSchema: { type: "object", properties: { task: TASK_ARG, comment: { type: "string", description: "Optional comment explaining why." } }, required: ["task"], additionalProperties: false },
    run: async (args, ctx) => {
      const { task, project } = await findTask(ctx, str(args, "task", true)!);
      const comment = str(args, "comment");
      if (comment) await addCommentAs(ctx.actor, task._id, comment);
      const c = await cols();
      const claim = await c.agentClaims.findOneAndDelete({ botId: ctx.bot._id, taskId: task._id });
      if (claim?.state === "in_progress") await publishWorking(ctx.org._id, ctx.bot._id, [task._id]);
      const key = `${project.key}-${task.number}`;
      if (claim?.kind === "triage") {
        const fresh = await c.tasks.findOne({ _id: task._id }, { projection: { statusId: 1, archivedAt: 1, title: 1 } });
        const st = fresh && (await c.statuses.findOne({ _id: fresh.statusId }, { projection: { category: 1 } }));
        if (fresh && !fresh.archivedAt && st?.category === "triage") {
          // Offer it to another connected triage bot; polling triagers see it on their next check_for_triage.
          wakeTriage(ctx.org._id, { taskId: task._id, taskKey: key, title: fresh.title, by: ctx.bot.name, exclude: ctx.bot._id });
        }
        return { content: [text(`Handed ${key} back for triage.`)] };
      }
      return { content: [text(`Released ${key}.`)] };
    },
  },

  advance_task: {
    description:
      "Move a task on from a flow step that waits for an outside event (`flow.step.advance` is \"wait\", e.g. \"Customer reply\"), once that event has happened: Aimpoint moves it to the next step's status and hands it to that step's owner, with your comment as the hand-off note. Say what happened in `comment` (e.g. \"Reply received from J. Smith: wants a quote for 2 bathrooms\"). Allowed for the step's owner, its resolver bots (`flow.step.wait.resolvers`), and the task's assignee or creator; you don't need to be assigned. Any other step moves on with complete_task (without a status) from its owner instead, so this is refused there.",
    inputSchema: {
      type: "object",
      properties: { task: TASK_ARG, comment: { type: "string", description: "What happened, posted on the task before it moves on. Plain text; mention people with <@id>." } },
      required: ["task"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const { task, project } = await findTask(ctx, str(args, "task", true)!);
      const comment = str(args, "comment");
      const key = `${project.key}-${task.number}`;
      const flow = task.flow?.paused ? null : await loadTaskFlow(task);
      const step = flow?.current;
      if (!flow || !step || !flow.status) throw new ToolInputError(`${key} isn't at a step of a flow${task.flow?.paused ? " (its flow is paused)" : ""}, so there's nothing to advance. Use complete_task or set_status.`);
      if (step.advance !== "wait") {
        throw new ToolInputError(`${key} is at the ${step.name} step, which doesn't wait for an outside event: its owner (${ownerName(flow.dir, step)}) hands it on with complete_task without a status.`);
      }
      const me = ctx.bot._id.toHexString();
      const may =
        (step.owner.kind === "bot" && step.owner.id === me) ||
        (step.wait?.resolvers ?? []).includes(me) ||
        task.assigneeId?.equals(ctx.bot._id) ||
        task.createdBy.equals(ctx.bot._id);
      if (!may) {
        const resolvers = (step.wait?.resolvers ?? []).map((id) => flow.dir.bots.get(id) ?? id);
        const who = [
          step.owner.kind === "bot" || step.owner.kind === "person" ? `the ${step.name} step's owner (${ownerName(flow.dir, step)})` : null,
          resolvers.length ? `its resolver bots (${resolvers.join(", ")})` : null,
          "the task's assignee or creator",
        ].filter(Boolean);
        throw new ToolInputError(`Only ${who.join(", ")}, or a person can move ${key} on from ${step.name}. You can still comment.`);
      }
      const to = nextStepOf(flow.flow, step);
      if (!to) throw new ToolInputError(`${key} is at the last step of its flow; nothing comes after ${step.name}.`);
      if (comment) await addCommentAs(ctx.actor, task._id, comment);
      const target: AdvanceTarget = { kind: "advance", from: step, to, statusChanges: to.status.id !== flow.status.id };
      // The waiting bot isn't working on it any more: finish its round before the move, so a hand-off back to it (it
      // owns the next step too) starts a fresh one and the move's broadcast shows the working ring cleared.
      await (await cols()).agentClaims.updateMany({ botId: ctx.bot._id, taskId: task._id, kind: { $ne: "triage" }, state: "in_progress" }, { $set: { state: "done", finishedAt: new Date() } });
      const t = await updateTaskAs(ctx.actor, task._id, target.statusChanges ? { statusId: to.status.id } : {}, { flowTo: to.id, flowResolver: true });
      const note = await flowReplyNote(ctx, task._id, target);
      return { content: [text(`${step.wait?.label ?? step.name}: resolved on ${key}.${note}${comment ? " Comment posted." : ""}${blockersNote(assignedBlockersOf(t))}`)] };
    },
  },

  get_task: {
    readOnly: true,
    description:
      "Everything about one task: project, status, priority, assignee, due date, description (Markdown), images (attached inline), every comment and the activity history, and its place in its project's flow (`flow`: the current step with its owner and instructions, the next step and who gets it, who has it now, and `howToFinish`). Doesn't change any state.",
    inputSchema: { type: "object", properties: { task: TASK_ARG, include_images: IMAGES_ARG }, required: ["task"], additionalProperties: false },
    run: async (args, ctx) => {
      const { task, project } = await findTask(ctx, str(args, "task", true)!);
      return taskResult(ctx, task, project, `${project.key}-${task.number} "${task.title}"`, { includeImages: bool(args, "include_images", true) });
    },
  },

  list_tasks: {
    readOnly: true,
    description: "Find tasks. Filters combine. Archived tasks are left out unless include_archived is true. Most recently updated first.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project key (WEB), name or id." },
        status: { type: "string", description: "Status name or id. With `project`, a status of that project; without, every project's status of that name." },
        assignee: { type: "string", description: '"me", "none", a person\'s name or email, a bot\'s name, or an id.' },
        query: { type: "string", description: "Text to find in titles." },
        include_archived: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const filter: Filter<TaskDoc> = { orgId: ctx.org._id };
      if (!bool(args, "include_archived", false)) filter.archivedAt = null;
      const project = str(args, "project");
      if (project) filter.projectId = (await resolveProject(ctx, project))._id;
      const status = str(args, "status");
      if (status) filter.statusId = { $in: await statusFilterIds(ctx.org._id, status, filter.projectId as ObjectId | undefined) };
      const assignee = str(args, "assignee");
      if (assignee) filter.assigneeId = assignee.toLowerCase() === "none" ? null : new ObjectId(resolvePerson(await loadDirectory(ctx.org._id), ctx.bot._id, assignee));
      const query = str(args, "query");
      if (query) filter.title = { $regex: query.slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);
      const docs = await (await cols()).tasks.find(filter, { projection: { description: 0 } }).sort({ updatedAt: -1 }).limit(limit).toArray();
      return { content: [json({ tasks: await summarise(ctx, docs as TaskDoc[]) })] };
    },
  },

  get_workspace: {
    readOnly: true,
    description: "Who you are, the tools your role allows, the organisation's projects (each with its context: admin-set key/value notes such as repos and conventions, and its own statuses in workflow order with their stage; statuses are per project and a task only takes its own project's), each project's resolved flow (`flow`: who handles a task at each step, in order, with the step's status and instructions; null when flows are off), how the stages and flows work, and people and bots with their ids, for assigning and @mentioning.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async (_args, ctx) => {
      const c = await cols();
      const [ws, tools, role] = await Promise.all([workspaceSummary(ctx), toolsForBot(ctx.bot), ctx.bot.roleId ? c.botRoles.findOne({ _id: ctx.bot.roleId }) : null]);
      return {
        content: [
          json({
            you: { id: ctx.bot._id.toHexString(), name: ctx.bot.name, description: ctx.bot.description, role: role?.name ?? null, tools: [...tools] },
            ...ws,
            mentions: "To tag someone in a comment, write <@id> in the body or pass their name in `mention`.",
          }),
        ],
      };
    },
  },

  get_analytics: {
    readOnly: true,
    description:
      "The organisation's analytics report for a period (the same data as the admin Analytics screen and its CSV export): tickets opened, closed (done/cancelled), reopened, backlog and open-task age over time, cycle time (median/p90 ms), comments and interactions split people vs bots, per-project breakdowns, tasks by stage/priority/type and top contributors. Every count has `total`, `previous` (the equal-length period before) and `series` (one value per entry of `buckets`, bucket starts as ISO instants). Archived tasks are left out; closed = moved into a done or cancelled stage. Doesn't change any state.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: ANALYTICS_PARAM_DOCS.from },
        to: { type: "string", description: ANALYTICS_PARAM_DOCS.to },
        granularity: { type: "string", enum: [...ANALYTICS_GRANULARITIES], description: ANALYTICS_PARAM_DOCS.granularity },
        project: { type: "string", description: ANALYTICS_PARAM_DOCS.project },
        person: { type: "string", description: ANALYTICS_PARAM_DOCS.person },
        bot: { type: "string", description: ANALYTICS_PARAM_DOCS.bot },
        tz: { type: "string", description: ANALYTICS_PARAM_DOCS.tz },
      },
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const { query, project } = await resolveAnalyticsExport(ctx.org._id, args);
      const r = await computeAnalytics(ctx.org._id, query);
      const t = r.tickets;
      return {
        content: [
          text(`Analytics for ${project ? `${project.key} (${project.name})` : "all projects"}${r.period.contributor ? `, ${r.period.contributor.name} only` : ""}, ${r.period.from} to ${r.period.to} by ${r.period.granularity} (${r.period.tz}): ${t.opened.total} opened, ${t.closed.total} closed, backlog ${t.backlog.start} -> ${t.backlog.end}, ${r.messages.comments.total} comments.`),
          json({ project: project ? { id: project._id.toHexString(), key: project.key, name: project.name } : null, report: r }),
        ],
      };
    },
  },

  add_comment: {
    description:
      "Comment on any task in the organisation. Plain text, not Markdown: no **bold**, headings or tables (plain \"- \" lists are fine). Tag people or bots by passing names, emails or ids in `mention`, or by writing <@id> in the body; they'll be notified.",
    inputSchema: {
      type: "object",
      properties: {
        task: TASK_ARG,
        body: { type: "string", description: "The comment, plain text, up to 10,000 characters." },
        mention: { type: "array", items: { type: "string" }, description: "People or bots to tag: names, emails or ids. Added to the start of the comment." },
      },
      required: ["task", "body"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const { task, project } = await findTask(ctx, str(args, "task", true)!);
      let body = str(args, "body", true)!;
      const mention = Array.isArray(args.mention) ? args.mention.map(String).filter(Boolean) : [];
      if (mention.length) {
        const dir = await loadDirectory(ctx.org._id);
        const tokens = [...new Set(mention.map((m) => resolvePerson(dir, ctx.bot._id, m)))].filter((id) => !body.includes(`<@${id}>`)).map((id) => `<@${id}>`);
        if (tokens.length) body = `${tokens.join(" ")} ${body}`;
      }
      const item = await addCommentAs(ctx.actor, task._id, body);
      return { content: [text(`Commented on ${project.key}-${task.number}.`), json({ commentId: item.id, mentioned: item.mentions })] };
    },
  },

  set_status: {
    description: "Move a task to another status of its own project, by name. Statuses are per project: the task's project's names are under `project.statuses` in get_task (and per project in get_workspace); a name only another project has is refused and the task is left unchanged. Works on tasks you created or are assigned to. On a task you triaged, you can move it to a closing status (a done, cancelled or review status) once nothing it depends on is open. On a task whose flow is active, moving it to another step's status moves it to that step and hands it to that step's owner (the reply says who has it now); if that's you and you're still working on it, carry on and finish with complete_task. To finish your own step, prefer complete_task without a status: set_status doesn't mark your work finished.",
    inputSchema: { type: "object", properties: { task: TASK_ARG, status: { type: "string", description: 'A status name of the task\'s project, e.g. "In Progress" (or a stage such as "done" for its first status of that stage).' } }, required: ["task", "status"], additionalProperties: false },
    run: async (args, ctx) => {
      const { task } = await findTask(ctx, str(args, "task", true)!);
      const st = await resolveStatus(ctx, str(args, "status", true)!, task.projectId);
      const t = await updateTaskAs(ctx.actor, task._id, { statusId: st._id.toHexString() });
      // Where it is in its flow now and who has it (VEC-315), so a step owner moving it on sees the hand-off.
      const after = await (await cols()).tasks.findOne({ _id: task._id }, { projection: { flow: 1, assigneeId: 1, waitingOn: 1, triagedBy: 1 } });
      // A person paused its flow (VEC-325): say so, without the umbrella's "waits on sub-tasks" reason.
      const pausedNote = after?.flow?.paused && task.flow?.paused && !pausedAsUmbrella(after.flow, { waiting: !!after.waitingOn?.length, triaged: !!after.triagedBy }) ? pausedStatusNote : "";
      const stepMoved = !!after?.flow?.stepId && after.flow.stepId !== task.flow?.stepId && !after.flow.paused;
      const mine = stepMoved && !!after?.assigneeId?.equals(ctx.bot._id) && !!task.assigneeId?.equals(ctx.bot._id);
      const where = stepMoved ? await whereNow(ctx, task._id) : "";
      const working = mine && !!(await (await cols()).agentClaims.findOne({ taskId: task._id, botId: ctx.bot._id, kind: { $ne: "triage" }, state: "in_progress" }, { projection: { _id: 1 } }));
      const carryOn = !mine ? "" : working ? " You own that step too: carry on with it here, and finish with complete_task (without a status to hand it on)." : " You own that step too: you'll be handed it for that step.";
      return { content: [text(`${t.key} is now ${st.name}.${where}${carryOn}${pausedNote}${blockersNote(assignedBlockersOf(t))}`)] };
    },
  },

  assign_task: {
    description:
      'Assign a task to a person or bot (name, email or id), to yourself ("me"), or to nobody (null or "none"). Works on tasks you created or are assigned to. A bot an admin has disabled can\'t be assigned (it\'s left out of get_workspace). Once you hand a task you didn\'t create to someone else, you can only comment on it, so set its status first. A bot assigned to a task in a backlog-stage status (Backlog) isn\'t woken and the task doesn\'t move: it\'s parked, held until someone moves it to a not-started or started status (such as Todo), which hands it to the bot then.',
    inputSchema: {
      type: "object",
      properties: { task: TASK_ARG, assignee: { type: ["string", "null"], description: 'Name, email, id, "me", or null / "none" to unassign.' } },
      required: ["task", "assignee"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const { task } = await findTask(ctx, str(args, "task", true)!);
      const ref = str(args, "assignee");
      const dir = await loadDirectory(ctx.org._id);
      const id = !ref || ref.toLowerCase() === "none" ? null : resolvePerson(dir, ctx.bot._id, ref);
      const t = await updateTaskAs(ctx.actor, task._id, { assigneeId: id });
      const parked = id && dir.get(id)?.kind === "bot" && (await isParked(task));
      return { content: [text(id ? `${t.key} is now assigned to ${dir.get(id)?.name ?? id}.${parked ? " It's in a backlog status, so it's parked: the bot isn't woken until someone moves it to a not-started or started status." : ""}` : `${t.key} is now unassigned.`)] };
    },
  },

  update_task: {
    description:
      "Edit a task. On tasks you created you can change anything. On tasks assigned to you, priority, type and due date. Title, description, project, dependencies and archiving are creator-only. Description accepts Markdown and replaces the whole description. `depends_on` replaces the whole dependency list ([] removes them all). To reorder it in the shared manual order (what people see under Sort: Manual), pass `before` (the task it goes directly above) and/or `after` (the task it goes directly below), optionally with `status` and `project` to move it there in the same write; reordering is creator/admin only and can't be combined with other fields.",
    inputSchema: {
      type: "object",
      properties: {
        task: TASK_ARG,
        title: { type: "string" },
        description: { type: "string", description: "Markdown. Replaces the existing description." },
        type: { type: "string", enum: ["issue", "feature", "task"], description: TYPE_DESC },
        priority: { type: "string", enum: ["none", "low", "medium", "high"] },
        due_date: { type: ["string", "null"], description: "YYYY-MM-DD, or null to clear." },
        project: { type: "string", description: "Move to another project (key, name or id). The task gets a new key." },
        archived: { type: "boolean" },
        depends_on: DEPENDS_ARG,
        before: { type: "string", description: "Reorder: task key it should sit directly above." },
        after: { type: "string", description: "Reorder: task key it should sit directly below." },
        status: { type: "string", description: 'Status name of the task\'s project (of the destination project when `project` is given), e.g. "Todo". With before/after it moves there in the same write.' },
      },
      required: ["task"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const { task, project } = await findTask(ctx, str(args, "task", true)!);
      const destProject = str(args, "project") ? (await resolveProject(ctx, str(args, "project")!))._id : undefined;
      const status = str(args, "status") ? (await resolveStatus(ctx, str(args, "status")!, destProject ?? task.projectId))._id.toHexString() : undefined;
      if (str(args, "before") || str(args, "after")) {
        const extra = Object.keys(args).filter((k) => args[k] !== undefined && !["task", "before", "after", "status", "project"].includes(k));
        if (extra.length) throw new ToolInputError(`before/after can only be combined with status and project (got ${extra.join(", ")}).`);
        const keyOf = async (ref?: string) => {
          if (!ref) return null;
          const n = await findTask(ctx, ref);
          return `${n.project.key}-${n.task.number}`;
        };
        const t = await moveTask(ctx.actor, `${project.key}-${task.number}`, {
          beforeKey: await keyOf(str(args, "before")),
          afterKey: await keyOf(str(args, "after")),
          status,
          project: destProject?.toHexString(),
        });
        return { content: [text(`Moved ${t.key}.`), json({ key: t.key, rank: t.rank, url: taskUrl(ctx.origin, ctx.org, t.key) })] };
      }
      const patch: TaskPatch = {
        statusId: status,
        title: str(args, "title"),
        description: args.description === undefined ? undefined : markdownToHtml(String(args.description ?? "")),
        type: parseType(args.type),
        priority: parsePriority(args.priority),
        dueDate: args.due_date === undefined ? undefined : args.due_date === null || args.due_date === "" ? null : String(args.due_date),
        projectId: destProject?.toHexString(),
        archived: typeof args.archived === "boolean" ? args.archived : undefined,
        dependsOn: args.depends_on === undefined ? undefined : await resolveTaskIds(ctx, args.depends_on, "depends_on"),
      };
      if (Object.values(patch).every((v) => v === undefined)) throw new ToolInputError("Pass at least one field to change.");
      const t = await updateTaskAs(ctx.actor, task._id, patch);
      const owned = assignedBlockersOf(t);
      return { content: [text(`Updated ${t.key}.${blockersNote(owned)}`), json({ key: t.key, url: taskUrl(ctx.origin, ctx.org, t.key), ...(owned.length ? { assignedToYou: owned } : {}) })] };
    },
  },

  create_task: {
    description:
      "Create a task in a project. You become its creator, so you can edit it fully later. Description accepts Markdown. Use `depends_on` to chain work: e.g. create \"Log in\", then \"Create sandbox data\" depending on it, then \"Export report\" depending on that. Each assignee is handed their task only when everything it depends on is done. A task you file that blocks your own work (a bug found while verifying, a missing piece) needs an owner: pass `assignee` (\"me\" by default, or the person or bot who should do it). Leaving `assignee` out is only for triage sub-tasks whose owner is genuinely unclear; a blocker nobody owns wakes nobody, so if a task assigned to you waits on one, Aimpoint assigns it to you.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project key (WEB), name or id." },
        title: { type: "string" },
        description: { type: "string", description: "Markdown." },
        type: { type: "string", enum: ["issue", "feature", "task"], default: "issue", description: TYPE_DESC },
        status: { type: "string", description: "Status name of that project (statuses are per project, see get_workspace). Defaults to the project's first not-started status." },
        assignee: {
          type: "string",
          description:
            'Name, email, id or "me". A task you file that blocks your own work needs an owner: set this ("me" by default, or the person or bot who should do it). If a task assigned to you waits on it while it has no owner, Aimpoint assigns it to you and wakes you for it. Omit it only for triage sub-tasks whose owner is genuinely unclear.',
        },
        priority: { type: "string", enum: ["none", "low", "medium", "high"] },
        due_date: { type: "string", description: "YYYY-MM-DD" },
        depends_on: DEPENDS_ARG,
      },
      required: ["project", "title"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const project = await resolveProject(ctx, str(args, "project", true)!);
      const status = str(args, "status");
      const assignee = str(args, "assignee");
      const t = await createTaskAs(ctx.actor, {
        title: str(args, "title", true)!,
        projectId: project._id.toHexString(),
        type: parseType(args.type) ?? "issue",
        statusId: status ? (await resolveStatus(ctx, status, project._id))._id.toHexString() : undefined,
        assigneeId: assignee ? resolvePerson(await loadDirectory(ctx.org._id), ctx.bot._id, assignee) : null,
        priority: parsePriority(args.priority),
        description: args.description === undefined ? undefined : markdownToHtml(String(args.description)),
        dueDate: str(args, "due_date") ?? null,
        dependsOn: args.depends_on === undefined ? undefined : await resolveTaskIds(ctx, args.depends_on, "depends_on"),
      });
      const waiting = t.waitingOn.length ? await taskKeys(ctx.org._id, t.waitingOn.map((id) => new ObjectId(id))) : null;
      const note = waiting ? ` It waits on ${[...waiting.values()].join(", ")} and is handed to its assignee once ${waiting.size === 1 ? "that is" : "those are"} done.` : "";
      const owned = assignedBlockersOf(t);
      return {
        content: [
          text(`Created ${t.key} "${t.title}".${note}${blockersNote(owned)}`),
          json({ key: t.key, id: t.id, url: taskUrl(ctx.origin, ctx.org, t.key), ready: !waiting, waitingOn: waiting ? [...waiting.values()] : [], ...(owned.length ? { assignedToYou: owned } : {}) }),
        ],
      };
    },
  },
};

/** Reply note for blockers Aimpoint assigned to the calling bot because its own task now waits on them (VEC-107). */
function blockersNote(keys: string[]) {
  if (!keys.length) return "";
  const one = keys.length === 1;
  return ` Nobody owned ${keys.join(", ")}, which your task is waiting on, so ${one ? "it is" : "they are"} now assigned to you. You'll be woken for ${one ? "it" : "each one"} separately as soon as ${one ? "it is" : "each is"} ready to work on (straight away if nothing it depends on is open). Reassign with assign_task if someone else should do ${one ? "it" : "them"}.`;
}

/* ---------------- MCP surface ---------------- */

const INFO = new Map<string, ToolInfo>(MCP_TOOLS.map((t) => [t.name, t]));

export async function listTools(bot: BotDoc) {
  const allowed = await toolsForBot(bot);
  return MCP_TOOLS.filter((t) => allowed.has(t.name)).map((t) => {
    const impl = TOOLS[t.name];
    return {
      name: t.name,
      title: t.title,
      description: impl.description,
      inputSchema: impl.inputSchema,
      annotations: { title: t.title, readOnlyHint: !!impl.readOnly, destructiveHint: false, openWorldHint: false },
    };
  });
}

export class UnknownToolError extends Error {}

export async function callTool(name: string, args: Args, ctx: McpCtx): Promise<ToolResult> {
  const impl = TOOLS[name];
  if (!impl || !INFO.has(name)) throw new UnknownToolError(`Unknown tool: ${name}`);
  if (!(await toolsForBot(ctx.bot)).has(name)) {
    return { isError: true, content: [text(`${ctx.bot.name}'s bot role doesn't allow ${name}. Ask an admin to change the role under Settings → Bots → Roles.`)] };
  }
  // VEC-263: an org without a live subscription (hosted, unpaid) is locked: every tool answers with the lock message.
  await billingOn();
  const locked = orgLockMessage(ctx.org);
  if (locked) return { isError: true, content: [text(locked)] };
  try {
    // VEC-216: the bot a person stopped can't write to that task, or link to it, until it's resumed. Checked before the
    // tool runs, so complete_task / release_task / advance_task never touch the stopped claim either.
    if (!impl.readOnly) {
      const a = args ?? {};
      const refs = [a.task, a.before, a.after, ...(Array.isArray(a.depends_on) ? a.depends_on : [])].filter((r): r is string | number => typeof r === "string" || typeof r === "number");
      const ids: ObjectId[] = [];
      for (const ref of refs) {
        try {
          ids.push((await findTask(ctx, String(ref))).task._id);
        } catch {} // unknown keys are the tool's own error to report
      }
      const refusal = await stopRefusal(ctx.bot._id, ids, { reply: name === "add_comment" && a.task !== undefined && ids.length === 1 });
      if (refusal) return { isError: true, content: [text(refusal.message)] };
    }
    return await impl.run(args ?? {}, ctx);
  } catch (err) {
    if (err instanceof ToolInputError || err instanceof UserError) return { isError: true, content: [text(err.message)] };
    console.error(`[mcp] ${name}`, err);
    return { isError: true, content: [text("Something went wrong on the Aimpoint side. Try again.")] };
  }
}

export const SERVER_INSTRUCTIONS = `You are a bot in a Aimpoint issue tracker organisation. People assign you tasks and @mention you in comments.
Typical loop: call check_for_work. It returns one item at a time:
- kind "mention": someone tagged you in a comment. Read the task and thread, then reply with add_comment.
- kind "closeout": a task you triaged whose sub-tasks are all done. Summarise what they delivered with add_comment, then complete_task it with Done (or In Review if something was cancelled or left open).
- kind "assigned": a task assigned to you, now picked up by you and moved to In Progress for you (from Todo or another started status; tasks in Backlog are never handed out or moved, see below). Do the work, hand it on with assign_task if needed, then call complete_task with Done (releases the tasks waiting on it), or In Review only when a named person must check something (@mention them).
- kind "idle": nothing new.
While you work an assigned task (or one a mention handed back to you), keep its ticket posted with add_comment: a short plan when you pick it up, then a few plain-text lines at each milestone and at least every ~10 minutes saying what's done and what's next, never one per tool call, and straight away when you're blocked or waiting on someone (@mention them). The assigned hand-out repeats the details.
A person can stop your work on a task (Stop in the task's menu). If a tool call is refused with "<name> stopped your work on KEY; don't continue", stop working on that task: don't retry the call or work around it, leave it as it is and end your turn. The task's \`stopped\` field says who stopped it and when; while it's stopped you're only allowed to answer a comment that @mentions you on it. If they resume it, you're handed it again with a fresh wake-up.
Call check_for_work again until it says idle. Use get_workspace for project keys, each project's statuses and people's ids.
Statuses are per project: every project has its own list, a task only takes a status of its own project (by that project's names; a task's context lists them under \`project.statuses\`), and Aimpoint acts on each status's stage (backlog, triage, unstarted, started, done, cancelled), not its name. The names used here (Backlog, Todo, In Progress, In Review, Done, Cancelled) are the defaults; a project may have renamed them.\nA task in a backlog-stage status (Backlog) is parked, not work: being assigned to it records you as its assignee only. It's held (no wake-up, check_for_work doesn't offer it, pickup never moves it out of Backlog; list_my_tasks shows it with \`parked: true\`) until someone moves it to a not-started or started status such as Todo, which hands it to you as an assignment. Leave parked tasks alone unless a flow step in that status names you as its owner.
If your role allows check_for_triage, you're also a triage bot: call it on your schedule. Each call hands you one task waiting in the Triage status (no other bot gets it); break it into concrete tasks with create_task, chain them with \`depends_on\` so they run in a logical order, make the original depend on them, then complete_task it with a status that moves it out of Triage. When those tasks are all done, check_for_work hands you the original back as kind "closeout": summarise what was delivered with add_comment, then complete_task it with Done (or In Review if something was cancelled or left open).
Projects can have a flow: an ordered list of steps, each with an owner (a bot, a person, any triage bot, whoever has it, or nobody), a status and instructions (\`flow\` per project in get_workspace, and in each task's context: the step it's at, what comes next, who has it, \`howToFinish\`). On a task whose flow is active, finish your step with complete_task WITHOUT a status: Aimpoint moves it to the next step's status and hands it to that step's owner, and the reply says where it went. Saying you're done in chat or in your run's last message doesn't move the task: only complete_task does. Pass an earlier step's status to send it back (say why in the comment); bots can't skip a required step, Done included. A wait step (\`flow.step.advance\` "wait") moves on with advance_task once what it waits for has happened. Where the flow isn't active (\`flow.active\` false or \`flow\` null), finish with a status as described above.
Tasks can depend on other tasks (\`depends_on\` on create_task / update_task). A task isn't offered or pushed to its assignee until everything it depends on is closed (a done or cancelled status; the ready message says which were cancelled); moving your task to a done or cancelled status (set_status or complete_task with a status) releases the tasks waiting on it. A task you file that blocks your own work needs an owner: create it with \`assignee\` ("me" by default, or whoever should do it). If you send your task back to wait on new blockers, every blocker must be assigned; Aimpoint assigns any that nobody owns to you and hands them to you.\nComments are plain text: write add_comment and complete_task comments without Markdown (no **bold**, headings or tables); plain "- " lists are fine. Task descriptions do accept Markdown.`;
