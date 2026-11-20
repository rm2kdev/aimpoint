import "server-only";
import { ObjectId, type Filter } from "mongodb";
import sanitizeHtml from "sanitize-html";
import { cols } from "@/lib/db";
import { mcpServerNameFor } from "@/lib/mcp-name";
import { addRunStalls } from "@/lib/run-stalled";
import type {
  ActivityDoc,
  Bot,
  BotDoc,
  BotRole,
  BotRoleDoc,
  BotWorkload,
  WorkloadSnapshot,
  CommentDoc,
  Counts,
  FeedItem,
  Member,
  Project,
  ProjectDetail,
  ProjectDoc,
  Status,
  Stalled,
  StatusDoc,
  Task,
  TaskDetail,
  TaskDoc,
  TaskRef,
  TaskSource,
  TaskSourceDoc,
} from "@/lib/types";
import { botMaxTasks } from "@/lib/types";
import { sortByProjectOrder, type ProjectOrder } from "@/lib/project-order";
import { atWaitStep } from "@/lib/flow-engine";

/** The status set every new project starts with (VEC-114: statuses belong to a project). */
export const DEFAULT_STATUSES: Omit<StatusDoc, "_id" | "orgId" | "projectId">[] = [
  { name: "Backlog", color: "#a3a3a3", category: "backlog", order: 0 },
  { name: "Triage", color: "#d6409f", category: "triage", order: 1 },
  { name: "Todo", color: "#737373", category: "unstarted", order: 2 },
  { name: "In Progress", color: "#e5a00d", category: "started", order: 3 },
  { name: "In Review", color: "#8b5cf6", category: "started", order: 4 },
  { name: "Done", color: "#2f6fed", category: "done", order: 5 },
  { name: "Cancelled", color: "#a3a3a3", category: "cancelled", order: 6 },
];

export const PROJECT_COLORS = ["#2f6fed", "#30a46c", "#e5a00d", "#8b5cf6", "#e5484d", "#0ea5b7", "#d6409f", "#737373"];

export const toBot = (b: BotDoc): Bot => ({
  id: b._id.toHexString(),
  name: b.name,
  description: b.description,
  avatar: b.avatar,
  keyHint: b.keyHint,
  keyRotatedAt: b.keyRotatedAt.toISOString(),
  lastUsedAt: b.lastUsedAt?.toISOString() ?? null,
  roleId: b.roleId?.toHexString() ?? null,
  maxTasks: botMaxTasks(b),
  mcpServerName: mcpServerNameFor(b),
  connection: b.connection
    ? {
        agent: b.connection.agent,
        method: b.connection.method,
        url: b.connection.url ?? null,
        model: b.connection.model ?? null,
        secretHint: b.connection.secretHint ?? null,
        updatedAt: b.connection.updatedAt.toISOString(),
        lastDelivery: b.connection.lastDelivery
          ? {
              at: b.connection.lastDelivery.at.toISOString(),
              ok: b.connection.lastDelivery.ok,
              reason: b.connection.lastDelivery.reason,
              status: b.connection.lastDelivery.status ?? null,
              error: b.connection.lastDelivery.error ?? null,
            }
          : null,
      }
    : null,
  createdBy: b.createdBy.toHexString(),
  createdAt: b.createdAt.toISOString(),
});

export const toBotRole = (r: BotRoleDoc): BotRole => ({
  id: r._id.toHexString(),
  name: r.name,
  description: r.description,
  tools: r.tools,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export const toProject = (p: ProjectDoc): Project => ({
  id: p._id.toHexString(),
  name: p.name,
  key: p.key,
  color: p.color,
  archived: !!p.archivedAt,
  newTaskStatusId: p.defaults?.newTaskStatusId?.toHexString() ?? null,
  public: !!p.publicAccess?.enabled,
});
export const toProjectDetail = (p: ProjectDoc): ProjectDetail => ({
  ...toProject(p),
  metadata: p.metadata ?? [],
  createdAt: p.createdAt.toISOString(),
  archivedAt: p.archivedAt?.toISOString() ?? null,
});

/** Project metadata as a plain object for agents. Keys are unique (enforced on save). */
export const projectContext = (p: ProjectDoc): Record<string, string> => Object.fromEntries((p.metadata ?? []).map((m) => [m.key, m.value]));
export const toStatus = (s: StatusDoc): Status => ({
  id: s._id.toHexString(),
  projectId: s.projectId?.toHexString() ?? "",
  name: s.name,
  color: s.color,
  category: s.category,
  order: s.order,
});

/** `workingBotIds` defaults to none: lists fill it with withWorkingBots(), publish() fills it on task.upsert. */
export function toTask(t: TaskDoc, projectKey: string, workingBotIds: string[] = []): Task {
  return {
    id: t._id.toHexString(),
    projectId: t.projectId.toHexString(),
    key: `${projectKey}-${t.number}`,
    number: t.number,
    title: t.title,
    type: t.type,
    statusId: t.statusId.toHexString(),
    assigneeId: t.assigneeId?.toHexString() ?? null,
    priority: t.priority,
    dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
    archivedAt: t.archivedAt?.toISOString() ?? null,
    archivedBy: t.archivedBy?.toHexString() ?? null,
    dependsOn: (t.dependsOn ?? []).map((id) => id.toHexString()),
    waitingOn: (t.waitingOn ?? []).map((id) => id.toHexString()),
    workingBotIds,
    stalled: null,
    rank: t.rank ?? "",
    flow: t.flow ? { stepId: t.flow.stepId ?? null, paused: !!t.flow.paused, enteredAt: new Date(t.flow.enteredAt).toISOString() } : null,
    source: t.source ? toTaskSource(t.source) : null,
    stopped: t.stopped ? { by: t.stopped.by.toHexString(), at: t.stopped.at.toISOString(), botId: t.stopped.botId.toHexString(), kind: t.stopped.kind } : null,
    createdBy: t.createdBy.toHexString(),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
export const toTaskSource = (s: TaskSourceDoc): TaskSource =>
  s.kind === "public"
    ? { kind: "public", userId: s.userId.toHexString(), userName: s.userName }
    : {
        kind: s.kind,
        formId: s.formId.toHexString(),
        formName: s.formName,
        submitterName: s.submitterName ?? null,
        submitterEmail: s.submitterEmail ?? null,
      };
export const toTaskDetail = (
  t: TaskDoc,
  projectKey: string,
  refs: { dependencies: TaskRef[]; dependents: TaskRef[] },
  workingBotIds: string[] = [],
): TaskDetail => ({
  ...toTask(t, projectKey, workingBotIds),
  description: t.description,
  ...refs,
});

/**
 * Bots holding an in-progress claim (picked up as assignee, or triaging), per task id. One query for any
 * number of tasks.
 */
export async function loadWorkingBots(taskIds: ObjectId[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!taskIds.length) return out;
  const c = await cols();
  const claims = await c.agentClaims
    .find({ taskId: { $in: taskIds }, state: "in_progress" }, { projection: { taskId: 1, botId: 1 } })
    .sort({ claimedAt: 1 })
    .toArray();
  for (const cl of claims) {
    const k = cl.taskId.toHexString();
    const ids = out.get(k) ?? [];
    const bot = cl.botId.toHexString();
    if (!ids.includes(bot)) ids.push(bot);
    out.set(k, ids);
  }
  return out;
}

/** Fills `workingBotIds` and `stalled` on these tasks (in place): one claims query, plus a few more only when some are stalled candidates. */
export async function withWorkingBots<T extends Task>(tasks: T[]): Promise<T[]> {
  const working = await loadWorkingBots(tasks.map((t) => new ObjectId(t.id)));
  // Nobody works on a closed task: a claim left over on one (closed elsewhere, or a status turned into a
  // done stage) never shows the ring.
  const busy = tasks.filter((t) => working.has(t.id));
  const closedStatus = busy.length ? await closedStatusIds(busy.map((t) => t.statusId)) : new Set<string>();
  for (const t of tasks) t.workingBotIds = closedStatus.has(t.statusId) ? [] : (working.get(t.id) ?? []);
  const stalled = await loadStalled(tasks);
  for (const t of tasks) t.stalled = stalled.get(t.id) ?? null;
  return tasks;
}

/**
 * Per-bot active task count for the org: non-triage `in_progress` claims on open (not done/cancelled),
 * unarchived tasks, the same rules withWorkingBots uses for the ring, so a claim left on a closed task never
 * counts. Every bot in the org gets an entry (0 when idle). Kept live by refreshWorkload() in publish().
 */
export async function loadBotWorkload(orgId: ObjectId): Promise<BotWorkload[]> {
  const c = await cols();
  const [bots, claims] = await Promise.all([
    c.bots.find({ orgId }, { projection: { _id: 1 } }).sort({ createdAt: 1 }).toArray(),
    c.agentClaims.find({ orgId, state: "in_progress", kind: { $ne: "triage" } }, { projection: { taskId: 1, botId: 1 } }).toArray(),
  ]);
  const active = new Map<string, Set<string>>(bots.map((b) => [b._id.toHexString(), new Set<string>()]));
  if (claims.length) {
    const closed = await c.statuses.find({ orgId, category: { $in: ["done", "cancelled"] } }, { projection: { _id: 1 } }).toArray();
    const open = await c.tasks
      .find(
        { _id: { $in: [...new Set(claims.map((cl) => cl.taskId.toHexString()))].map((id) => new ObjectId(id)) }, orgId, archivedAt: null, statusId: { $nin: closed.map((s) => s._id) } },
        { projection: { _id: 1 } },
      )
      .toArray();
    const openIds = new Set(open.map((t) => t._id.toHexString()));
    for (const cl of claims) {
      const task = cl.taskId.toHexString();
      if (openIds.has(task)) active.get(cl.botId.toHexString())?.add(task);
    }
  }
  return [...active].map(([botId, tasks]) => ({ botId, active: tasks.size }));
}

/** loadBotWorkload stamped with the time taken before the query (see WorkloadSnapshot). */
export async function loadWorkloadSnapshot(orgId: ObjectId): Promise<WorkloadSnapshot> {
  const at = Date.now();
  return { at, bots: await loadBotWorkload(orgId) };
}

/** Which of these status ids are done or cancelled. */
async function closedStatusIds(statusIds: string[]): Promise<Set<string>> {
  const c = await cols();
  const ids = [...new Set(statusIds)].map((id) => new ObjectId(id));
  return new Set((await c.statuses.find({ _id: { $in: ids }, category: { $in: ["done", "cancelled"] } }, { projection: { _id: 1 } }).toArray()).map((s) => s._id.toHexString()));
}

/**
 * Which of these tasks are stalled (see Stalled): open, not archived, nobody working on them, at least one
 * open task waiting on them, and either unassigned or assigned to a bot that already finished its work and isn't
 * waiting on dependencies of its own. An unassigned task that is waiting on its own dependencies gets the softer
 * "needs_owner" reason instead of "unassigned".
 */
export async function loadStalled(tasks: Task[]): Promise<Map<string, Stalled>> {
  const out = await stalledByWaiters(tasks);
  // VEC-316: "unfinished" (runs that ended twice without complete_task) and flow tasks finished at a step with no
  // hand-off, whether or not anything waits on them.
  await addRunStalls(tasks, out);
  return out;
}

async function stalledByWaiters(tasks: Task[]): Promise<Map<string, Stalled>> {
  const out = new Map<string, Stalled>();
  const candidates = tasks.filter((t) => !t.archivedAt && !t.workingBotIds.length);
  if (!candidates.length) return out;
  const c = await cols();
  const ids = candidates.map((t) => new ObjectId(t.id));
  const statusIds = [...new Set(candidates.map((t) => t.statusId))].map((id) => new ObjectId(id));
  const openStatus = new Set(
    (await c.statuses.find({ _id: { $in: statusIds } }, { projection: { category: 1 } }).toArray())
      .filter((s) => s.category !== "done" && s.category !== "cancelled" && s.category !== "triage")
      .map((s) => s._id.toHexString()),
  );
  const open = candidates.filter((t) => openStatus.has(t.statusId));
  if (!open.length) return out;
  const openIds = new Set(open.map((t) => t.id));
  // Its bot was never reached: a wake-up for it gave up after every retry (VEC-101). Stalled whether or not anything
  // waits on it, since nobody is working on a task that says it's ready.
  const assignedOpen = open.filter((t) => t.assigneeId);
  const undelivered = assignedOpen.length
    ? await c.botWakes
        .find({ taskId: { $in: assignedOpen.map((t) => new ObjectId(t.id)) }, failedAt: { $ne: null } }, { projection: { taskId: 1, botId: 1 } })
        .toArray()
    : [];
  const unreached = new Set(undelivered.map((w) => `${w.taskId.toHexString()}:${w.botId.toHexString()}`));
  for (const t of assignedOpen) if (unreached.has(`${t.id}:${t.assigneeId}`)) out.set(t.id, { reason: "undelivered", botId: t.assigneeId, blocking: [] });
  const waiters = await c.tasks
    .find({ waitingOn: { $in: ids.filter((id) => openIds.has(id.toHexString())) }, archivedAt: null }, { projection: { waitingOn: 1, projectId: 1, number: 1, statusId: 1, orgId: 1 } })
    .toArray();
  if (!waiters.length) return out;
  // A cancelled or done task keeps its waitingOn, so only count waiters that are still open themselves.
  const closed = new Set(
    (await c.statuses.find({ _id: { $in: [...new Map(waiters.map((w) => [w.statusId.toHexString(), w.statusId])).values()] }, category: { $in: ["done", "cancelled"] } }, { projection: { _id: 1 } }).toArray()).map((s) =>
      s._id.toHexString(),
    ),
  );
  const live = waiters.filter((w) => !closed.has(w.statusId.toHexString()));
  if (!live.length) return out;
  const projects = await c.projects.find({ _id: { $in: [...new Map(live.map((w) => [w.projectId.toHexString(), w.projectId])).values()] } }, { projection: { key: 1 } }).toArray();
  const pk = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
  const blocking = new Map<string, string[]>();
  for (const w of live) {
    const key = `${pk.get(w.projectId.toHexString()) ?? "?"}-${w.number}`;
    for (const id of w.waitingOn ?? []) {
      const k = id.toHexString();
      if (!openIds.has(k)) continue;
      blocking.set(k, [...(blocking.get(k) ?? []), key]);
    }
  }
  const blocked = open.filter((t) => blocking.has(t.id));
  if (!blocked.length) return out;
  // Assigned to a bot that finished its work on it (complete_task) and left it open. Not while the task waits on
  // its own open dependencies (`waitingOn` holds only those): the bot parked it, and the ready hand-off gives it back.
  const assigned = blocked.filter((t) => t.assigneeId && !t.waitingOn.length);
  const finished = assigned.length
    ? await c.agentClaims
        .find({ taskId: { $in: assigned.map((t) => new ObjectId(t.id)) }, state: "done" }, { projection: { taskId: 1, botId: 1 } })
        .toArray()
    : [];
  const finishedBy = new Set(finished.map((f) => `${f.taskId.toHexString()}:${f.botId.toHexString()}`));
  // ...nor while that bot (as the task's triager) has a close-out of it pending: Aimpoint already woke it to wrap the
  // task up, and VEC-85 kept its done claim for that (VEC-89). Once it handled the close-out, the rule applies again.
  const maybeFinished = assigned.filter((t) => finishedBy.has(`${t.id}:${t.assigneeId}`));
  const closingOut = maybeFinished.length
    ? await c.tasks
        .find({ _id: { $in: maybeFinished.map((t) => new ObjectId(t.id)) }, "closeout.botId": { $exists: true }, "closeout.resolvedAt": null }, { projection: { closeout: 1 } })
        .toArray()
    : [];
  for (const d of closingOut) if (d.closeout) finishedBy.delete(`${d._id.toHexString()}:${d.closeout.botId.toHexString()}`);
  // ...nor while the task sits at a flow wait step (VEC-181): its bot was told what to watch for and its claim is done
  // on purpose (design 5.7); the task is waiting for an outside event, not left behind.
  const stillFinished = maybeFinished.filter((t) => finishedBy.has(`${t.id}:${t.assigneeId}`));
  if (stillFinished.length) {
    const docs = await c.tasks.find({ _id: { $in: stillFinished.map((t) => new ObjectId(t.id)) } }, { projection: { orgId: 1, projectId: 1, statusId: 1, flow: 1 } }).toArray();
    for (const d of docs) if (await atWaitStep(d)) finishedBy.delete(`${d._id.toHexString()}:${stillFinished.find((t) => t.id === d._id.toHexString())!.assigneeId}`);
  }
  const byKey = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  for (const t of blocked) {
    const keys = blocking.get(t.id)!.sort(byKey);
    const unreachedBot = out.get(t.id);
    if (unreachedBot?.reason === "undelivered") {
      unreachedBot.blocking = keys;
      continue;
    }
    // Unassigned but still waiting on its own open dependencies: nothing is held up by it yet, so only hint that
    // it needs an owner (VEC-86); it turns into red "unassigned" Stalled once those close.
    if (!t.assigneeId) out.set(t.id, { reason: t.waitingOn.length ? "needs_owner" : "unassigned", botId: null, blocking: keys });
    else if (!t.waitingOn.length && finishedBy.has(`${t.id}:${t.assigneeId}`)) out.set(t.id, { reason: "finished", botId: t.assigneeId, blocking: keys });
  }
  return out;
}

export function toFeed(doc: CommentDoc | ActivityDoc): FeedItem {
  if ("body" in doc) {
    return {
      id: doc._id.toHexString(),
      kind: "comment",
      actorId: doc.authorId.toHexString(),
      body: doc.body,
      mentions: doc.mentions?.map((m) => m.toHexString()) ?? [],
      createdAt: doc.createdAt.toISOString(),
    };
  }
  return {
    id: doc._id.toHexString(),
    kind: doc.kind,
    actorId: doc.actorId.toHexString(),
    from: doc.from ?? null,
    to: doc.to ?? null,
    ...(doc.note ? { note: doc.note } : {}),
    ...(doc.waiter ? { waiter: doc.waiter } : {}),
    ...(doc.kind === "flow_step" ? { flowStatus: doc.flowStatus ?? null, flowOwner: doc.flowOwner ?? null } : {}),
    createdAt: doc.createdAt.toISOString(),
  };
}

export function sanitizeDescription(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ["p", "br", "strong", "em", "s", "u", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "a", "img", "hr"],
    allowedAttributes: { a: ["href", "target", "rel"], img: ["src", "alt", "width", "height"], code: ["class"], pre: ["class"] },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowProtocolRelative: false,
    // A public form's links (VEC-234, lib/form-rich-core.ts) arrive with nofollow added; keep it, add nothing else.
    transformTags: {
      a: (tagName, attribs) => ({
        tagName: "a",
        attribs: { ...attribs, target: "_blank", rel: /(^|\s)nofollow(\s|$)/.test(attribs.rel ?? "") ? "noopener noreferrer nofollow" : "noopener noreferrer" },
      }),
    },
  }).slice(0, 200_000);
}

/* ---------------- shell data ---------------- */

export async function loadShell(orgId: ObjectId, userId: ObjectId) {
  const c = await cols();
  const [projects, statuses, memberships, bots] = await Promise.all([
    c.projects.find({ orgId }).sort({ createdAt: 1 }).toArray(),
    c.statuses.find({ orgId }).sort({ order: 1 }).toArray(),
    c.memberships.find({ orgId }).toArray(),
    c.bots.find({ orgId }).sort({ name: 1 }).toArray(),
  ]);
  const users = await c.users
    .find({ _id: { $in: memberships.map((m) => m.userId) } }, { projection: { passwordHash: 0 } })
    .toArray();
  const byId = new Map(users.map((u) => [u._id.toHexString(), u]));
  const members: Member[] = memberships
    .map((m): Member | null => {
      const u = byId.get(m.userId.toHexString());
      return u ? { id: u._id.toHexString(), name: u.name, email: u.email, role: m.role, kind: "user", ...(u.image ? { image: u.image } : {}) } : null;
    })
    .filter((m): m is Member => !!m)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const b of bots) {
    members.push({
      id: b._id.toHexString(),
      name: b.name,
      email: "",
      role: "member",
      kind: "bot",
      avatar: b.avatar,
      description: b.description,
      maxTasks: botMaxTasks(b),
      ownerId: b.createdBy.toHexString(),
    });
  }
  const counts = await loadCounts(orgId, userId, statuses);
  // The signed-in person's own sidebar order (none for bots, which have no membership).
  const mine = memberships.find((m) => m.userId.equals(userId));
  const projectOrder: ProjectOrder = {
    ids: (mine?.projectOrder ?? []).map((id) => id.toHexString()),
    at: mine?.projectOrderAt?.getTime() ?? 0,
  };
  return {
    projects: sortByProjectOrder(projects.map(toProject), projectOrder.ids),
    projectOrder,
    statuses: statuses.map(toStatus),
    members,
    counts,
  };
}

export async function loadCounts(orgId: ObjectId, userId: ObjectId, statuses?: StatusDoc[]): Promise<Counts> {
  const c = await cols();
  statuses ??= await c.statuses.find({ orgId }).toArray();
  const openIds = statuses.filter((s) => s.category !== "done" && s.category !== "cancelled").map((s) => s._id);
  const [rows, archived] = await Promise.all([
    c.tasks
    .aggregate<{ _id: ObjectId; n: number; mine: number }>([
      { $match: { orgId, statusId: { $in: openIds }, archivedAt: null } },
      { $group: { _id: "$projectId", n: { $sum: 1 }, mine: { $sum: { $cond: [{ $eq: ["$assigneeId", userId] }, 1, 0] } } } },
    ])
    .toArray(),
    c.tasks.countDocuments({ orgId, archivedAt: { $ne: null } }),
  ]);
  const projects: Record<string, number> = {};
  let all = 0;
  let my = 0;
  for (const r of rows) {
    projects[r._id.toHexString()] = r.n;
    all += r.n;
    my += r.mine;
  }
  return { my, all, archived, projects };
}

/* ---------------- people & bots ---------------- */

/** Assigned (open, not archived) and created task counts per member or bot id. */
export async function loadWorkStats(orgId: ObjectId, ids: ObjectId[]) {
  const c = await cols();
  const open = (await c.statuses.find({ orgId, category: { $nin: ["done", "cancelled"] } }, { projection: { _id: 1 } }).toArray()).map((s) => s._id);
  const [assigned, created] = await Promise.all([
    c.tasks
      .aggregate<{ _id: ObjectId; n: number }>([
        { $match: { orgId, assigneeId: { $in: ids }, statusId: { $in: open }, archivedAt: null } },
        { $group: { _id: "$assigneeId", n: { $sum: 1 } } },
      ])
      .toArray(),
    c.tasks
      .aggregate<{ _id: ObjectId; n: number }>([{ $match: { orgId, createdBy: { $in: ids } } }, { $group: { _id: "$createdBy", n: { $sum: 1 } } }])
      .toArray(),
  ]);
  const out: Record<string, { assigned: number; created: number }> = {};
  for (const id of ids) out[id.toHexString()] = { assigned: 0, created: 0 };
  for (const a of assigned) out[a._id.toHexString()].assigned = a.n;
  for (const a of created) out[a._id.toHexString()].created = a.n;
  return out;
}

/** Open, unarchived tasks assigned to someone, most recently updated first. */
export async function loadOpenAssigned(orgId: ObjectId, assigneeId: ObjectId, limit = 50): Promise<Task[]> {
  const c = await cols();
  const open = (await c.statuses.find({ orgId, category: { $nin: ["done", "cancelled"] } }, { projection: { _id: 1 } }).toArray()).map((s) => s._id);
  const [docs, projects] = await Promise.all([
    c.tasks
      .find({ orgId, assigneeId, statusId: { $in: open }, archivedAt: null }, { projection: { description: 0 } })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray(),
    c.projects.find({ orgId }, { projection: { key: 1 } }).toArray(),
  ]);
  const keys = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
  return withWorkingBots(docs.map((d) => toTask(d as TaskDoc, keys.get(d.projectId.toHexString()) ?? "?")));
}

/* ---------------- tasks ---------------- */

export interface TaskScope {
  projectId?: string;
  assigneeId?: string;
  archived?: boolean;
}

export async function listTasks(orgId: ObjectId, scope: TaskScope): Promise<Task[]> {
  const c = await cols();
  // archivedAt is absent on older tasks; `null` matches both missing and null.
  const filter: Filter<TaskDoc> = { orgId, archivedAt: scope.archived ? { $ne: null } : null };
  if (scope.projectId) filter.projectId = new ObjectId(scope.projectId);
  if (scope.assigneeId) filter.assigneeId = new ObjectId(scope.assigneeId);
  const [docs, projects] = await Promise.all([
    c.tasks.find(filter, { projection: { description: 0 } }).sort({ updatedAt: -1 }).limit(2000).toArray(),
    c.projects.find({ orgId }, { projection: { key: 1 } }).toArray(),
  ]);
  const keys = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
  return withWorkingBots(docs.map((d) => toTask(d as TaskDoc, keys.get(d.projectId.toHexString()) ?? "?")));
}

/** Resolve "WEB-12" within an org. */
export async function findTaskByKey(orgId: ObjectId, key: string): Promise<{ task: TaskDoc; project: ProjectDoc } | null> {
  const m = /^([A-Z][A-Z0-9]{0,9})-(\d+)$/.exec(key.toUpperCase());
  if (!m) return null;
  const c = await cols();
  const project = await c.projects.findOne({ orgId, key: m[1] });
  if (!project) return null;
  const task = await c.tasks.findOne({ projectId: project._id, number: Number(m[2]) });
  return task ? { task, project } : null;
}

export async function loadFeed(taskId: ObjectId): Promise<FeedItem[]> {
  const c = await cols();
  const [comments, activity] = await Promise.all([
    c.comments.find({ taskId }).sort({ createdAt: 1 }).limit(500).toArray(),
    c.activity.find({ taskId }).sort({ createdAt: 1 }).limit(500).toArray(),
  ]);
  return [...comments.map(toFeed), ...activity.map(toFeed)].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
