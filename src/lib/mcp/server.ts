import "server-only";
import { ObjectId, type Filter } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { findTaskByKey, projectContext } from "@/lib/data";
import { toolsForBot } from "@/lib/bots";
import { addCommentAs, createTaskAs, recordTriagedBy, updateTaskAs, type Actor, type TaskPatch } from "@/lib/task-service";
import { READY, taskKeys } from "@/lib/dependencies";
import { CLOSEOUT_STEPS, TRIAGE_STEPS, wakeTriage } from "@/lib/bot-dispatch";
import { publishWorking } from "@/lib/claims";
import { notify } from "@/lib/notifications";
import { MCP_TOOLS, type ToolInfo } from "@/lib/mcp/catalog";
import {
  buildTaskContext,
  loadDirectory,
  markdownToHtml,
  PRIORITY_LABEL,
  resolvePerson,
  taskUrl,
  ToolInputError,
  type ImageBlock,
} from "@/lib/mcp/context";
import type { BotDoc, OrgDoc, ProjectDoc, StatusDoc, TaskDoc } from "@/lib/types";

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

async function resolveStatus(ctx: McpCtx, ref: string, statuses?: StatusDoc[]) {
  statuses ??= await (await cols()).statuses.find({ orgId: ctx.org._id }).sort({ order: 1 }).toArray();
  const s = ref.trim().toLowerCase();
  const st = statuses.find((x) => x._id.toHexString() === s) ?? statuses.find((x) => x.name.toLowerCase() === s);
  if (!st) throw new ToolInputError(`Unknown status "${ref}". Statuses: ${statuses.map((x) => x.name).join(", ")}.`);
  return st;
}

function parsePriority(v: unknown) {
  if (v === undefined || v === null || v === "") return undefined;
  const i = typeof v === "string" ? (PRIORITY_LABEL as readonly string[]).indexOf(v.toLowerCase()) : -1;
  const n = i >= 0 ? i : Number(v);
  if (![0, 1, 2, 3].includes(n)) throw new ToolInputError("`priority` is none, low, medium or high.");
  return n as 0 | 1 | 2 | 3;
}

function parseType(v: unknown) {
  if (v === undefined || v === null || v === "") return undefined;
  if (v === "issue" || v === "feature") return v;
  throw new ToolInputError('`type` is "issue" or "feature".');
}

async function openStatusIds(orgId: ObjectId) {
  const c = await cols();
  return (await c.statuses.find({ orgId, category: { $nin: ["done", "cancelled"] } }, { projection: { _id: 1 } }).toArray()).map((s) => s._id);
}

/**
 * Assigned, open, unarchived tasks not yet picked up by this bot and ready to work on (every dependency done):
 * highest priority, then soonest due, then oldest.
 */
async function unclaimedAssigned(ctx: McpCtx) {
  const c = await cols();
  const tasks = await c.tasks
    .find({ orgId: ctx.org._id, assigneeId: ctx.bot._id, archivedAt: null, statusId: { $in: await openStatusIds(ctx.org._id) }, ...READY }, { projection: { description: 0 } })
    .limit(500)
    .toArray();
  const claimed = new Set(
    (await c.agentClaims.find({ botId: ctx.bot._id, taskId: { $in: tasks.map((t) => t._id) } }, { projection: { taskId: 1 } }).toArray()).map((x) => x.taskId.toHexString()),
  );
  const due = (t: TaskDoc) => t.dueDate?.getTime() ?? Number.POSITIVE_INFINITY;
  return tasks
    .filter((t) => !claimed.has(t._id.toHexString()))
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
    archivedAt: null,
    statusId: { $in: await openStatusIds(ctx.org._id) },
    ...READY,
  };
}

async function queueCounts(ctx: McpCtx) {
  const c = await cols();
  const [mentions, closeouts, assigned, blocked] = await Promise.all([
    c.botMentions.countDocuments({ botId: ctx.bot._id, deliveredAt: null }),
    c.tasks.countDocuments(await closeoutFilter(ctx)),
    unclaimedAssigned(ctx),
    blockedAssignedCount(ctx),
  ]);
  return { unreadMentions: mentions, pendingCloseouts: closeouts, unstartedAssignedTasks: assigned.length, assignedWaitingOnDependencies: blocked };
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
  return tasks.map((t) => {
    const key = `${pk.get(t.projectId.toHexString()) ?? "?"}-${t.number}`;
    return {
      key,
      title: t.title,
      type: t.type,
      status: st.get(t.statusId.toHexString()) ?? null,
      priority: PRIORITY_LABEL[t.priority],
      assignee: t.assigneeId ? dir.get(t.assigneeId.toHexString())?.name ?? "Former member" : null,
      dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
      archived: !!t.archivedAt,
      /** False while a task it depends on isn't done yet; `waitingOn` lists those. */
      ready: !t.waitingOn?.length,
      waitingOn: (t.waitingOn ?? []).map((id) => waitingKeys.get(id.toHexString()) ?? "a deleted task"),
      yourState: cl.get(t._id.toHexString()) ?? null,
      updatedAt: t.updatedAt.toISOString(),
      url: taskUrl(ctx.origin, ctx.org, key),
    };
  });
}

/** Projects (with their context), statuses in workflow order, and people and bots: what get_workspace returns. */
async function workspaceSummary(ctx: McpCtx) {
  const c = await cols();
  const [projects, statuses, dir] = await Promise.all([
    c.projects.find({ orgId: ctx.org._id }).sort({ createdAt: 1 }).toArray(),
    c.statuses.find({ orgId: ctx.org._id }).sort({ order: 1 }).toArray(),
    loadDirectory(ctx.org._id),
  ]);
  return {
    organisation: { id: ctx.org._id.toHexString(), name: ctx.org.name, slug: ctx.org.slug },
    projects: projects.map((p) => ({ id: p._id.toHexString(), key: p.key, name: p.name, archived: !!p.archivedAt, context: projectContext(p) })),
    statuses: statuses.map((s) => ({ id: s._id.toHexString(), name: s.name, stage: s.category })),
    people: [...dir.values()],
  };
}

/** Unarchived tasks in a Triage-stage status that no bot is triaging (or has triaged), oldest first. */
async function triageQueue(ctx: McpCtx) {
  const c = await cols();
  const ids = (await c.statuses.find({ orgId: ctx.org._id, category: "triage" }, { projection: { _id: 1 } }).toArray()).map((s) => s._id);
  if (!ids.length) return { hasTriage: false, tasks: [] as TaskDoc[] };
  const tasks = await c.tasks.find({ orgId: ctx.org._id, archivedAt: null, statusId: { $in: ids } }, { projection: { description: 0 } }).sort({ createdAt: 1 }).limit(500).toArray();
  const taken = new Set(
    (await c.agentClaims.find({ kind: "triage", taskId: { $in: tasks.map((t) => t._id) } }, { projection: { taskId: 1 } }).toArray()).map((x) => x.taskId.toHexString()),
  );
  return { hasTriage: true, tasks: (tasks as TaskDoc[]).filter((t) => !taken.has(t._id.toHexString())) };
}

/* ---------------- tools ---------------- */

/**
 * A bot finished its work on a task but left it in an open status (e.g. In Review) while other tasks wait
 * on it. They stay blocked until someone closes it, and no bot is working on it any more, so make sure a
 * person hears about it: the people the closing comment @mentioned (already notified), else the task's
 * creator when that's a person, else the organisation's admins. Returns a note for the tool reply, or "".
 */
async function reviewHandoff(ctx: McpCtx, taskId: ObjectId, key: string, comment: string | undefined | null): Promise<string> {
  const c = await cols();
  const orgId = ctx.org._id;
  const task = await c.tasks.findOne({ _id: taskId, orgId }, { projection: { statusId: 1, createdBy: 1, archivedAt: 1 } });
  if (!task || task.archivedAt) return "";
  const st = await c.statuses.findOne({ _id: task.statusId }, { projection: { category: 1, name: 1 } });
  if (!st || st.category === "done" || st.category === "cancelled") return "";
  const blocked = await c.tasks.find({ orgId, waitingOn: taskId, archivedAt: null }, { projection: { _id: 1 } }).toArray();
  if (!blocked.length) return "";
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
  return ` Note: ${st.name} isn't a closing status, so ${waiting} until it's moved to Done (or Cancelled).${who} If the work already meets its acceptance criteria, move ${key} to Done with set_status instead.`;
}

const TOOLS: Record<string, ToolImpl> = {
  check_for_work: {
    description:
      "\"Do I have a task?\" Call this on your schedule. Returns ONE item, most urgent first: (1) a comment that newly @mentioned you, with the full task and comment thread so you can reply; (2) a task you triaged whose sub-tasks are all done (`kind: \"closeout\"`): summarise what they delivered on it and close it out with complete_task; or (3) the next task assigned to you that you haven't picked up and that is ready (every task it depends on is done), which is then marked as picked up by you (invisible to people). Tasks still waiting on dependencies are held back until they're ready. Returns `kind: \"idle\"` when there's nothing new. Call again to get the next item.",
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
          .map((cm) => `> ${dir.get(cm.authorId.toHexString())?.name ?? "Someone"}: ${cm.body.replace(/<@([a-f0-9]{24})>/g, (_, id: string) => `@${dir.get(id)?.name ?? "former member"}`).replace(/\n/g, "\n> ")}`)
          .join("\n\n");
        const key = `${project.key}-${task.number}`;
        return taskResult(
          ctx,
          task,
          project,
          `You've been mentioned in a comment on ${key} "${task.title}" (project ${project.name}).\n\n${quote}\n\nRead the task and the whole thread below, then respond with add_comment (task "${key}"). The comments marked "new": true are the ones that mentioned you.`,
          { includeImages, highlight: commentIds, extra: { kind: "mention", mentionCommentIds: commentIds.map((id) => id.toHexString()), queue: await queueCounts(ctx) } },
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
          `${key} "${task.title}" in project ${project.name} is ready to close out: everything it depends on is done. You triaged it, so wrapping it up is yours:\n\n${CLOSEOUT_STEPS(key)}`,
          { includeImages, extra: { kind: "closeout", queue: await queueCounts(ctx) } },
        );
      }

      // 3. Assigned tasks not yet picked up.
      for (const t of await unclaimedAssigned(ctx)) {
        try {
          await c.agentClaims.insertOne({ _id: new ObjectId(), orgId: ctx.org._id, botId: ctx.bot._id, taskId: t._id, state: "in_progress", claimedAt: new Date(), finishedAt: null });
        } catch (err) {
          if ((err as { code?: number }).code === 11000) continue; // another run picked it up
          throw err;
        }
        await publishWorking(ctx.org._id, ctx.bot._id, [t._id]);
        const task = await c.tasks.findOne({ _id: t._id });
        const project = task && (await c.projects.findOne({ _id: task.projectId }));
        if (!task || !project) continue;
        const key = `${project.key}-${task.number}`;
        const deps = task.dependsOn?.length ? ` Everything it depends on is done (see \`dependencies.dependsOn\`); their comments may hold results you need.` : "";
        return taskResult(
          ctx,
          task,
          project,
          `You have a task: ${key} "${task.title}" in project ${project.name}, assigned to you.${deps} It's now marked as picked up by you (people don't see this). Work on it, keep people posted with add_comment, move it with set_status, and call complete_task when you're done (or release_task to hand it back). Moving it to a done status releases any tasks waiting on it.`,
          { includeImages, extra: { kind: "assigned", queue: await queueCounts(ctx) } },
        );
      }

      // 4. Nothing new.
      const inProgress = await c.agentClaims.find({ botId: ctx.bot._id, state: "in_progress", kind: { $ne: "triage" } }).sort({ claimedAt: 1 }).limit(50).toArray();
      const tasks = await c.tasks.find({ _id: { $in: inProgress.map((x) => x.taskId) } }, { projection: { description: 0 } }).toArray();
      const rows = await summarise(ctx, tasks as TaskDoc[]);
      const blocked = await blockedAssignedCount(ctx);
      const waitNote = blocked ? ` ${blocked} task${blocked === 1 ? " is" : "s are"} assigned to you but waiting on other tasks to be done; ${blocked === 1 ? "it" : "they"}'ll come through here once ready.` : "";
      return {
        content: [
          text(
            (rows.length ? `No new work. You still have ${rows.length} task${rows.length === 1 ? "" : "s"} picked up and not finished.` : blocked ? "No new work." : "No new work. Nothing is assigned to you and nobody has mentioned you.") + waitNote,
          ),
          json({ kind: "idle", stillInProgress: rows, assignedWaitingOnDependencies: blocked }),
        ],
      };
    },
  },

  check_for_triage: {
    description:
      "\"Is there anything to triage?\" Returns ONE task waiting in a Triage status (oldest first) that no other bot is triaging, with its full context and the workspace (projects, statuses, people and bots), and marks it as being triaged by you so no other bot is handed it. Your job is to break it into the concrete tasks needed to deliver it, created with create_task and chained with `depends_on` so the work happens in a logical order, then make the original task depend on them and move it out of Triage with complete_task. You stay its triager: when the tasks it depends on are all done, you're called back (a push wake-up, or `kind: \"closeout\"` on check_for_work) to summarise what was delivered and close it out. While you triage it you can edit it like its creator (not archive it). release_task hands it back. Returns `kind: \"idle\"` when nothing is waiting.",
    inputSchema: { type: "object", properties: { include_images: IMAGES_ARG }, additionalProperties: false },
    run: async (args, ctx) => {
      const c = await cols();
      const { hasTriage, tasks } = await triageQueue(ctx);
      if (!hasTriage) {
        return {
          content: [
            text("This organisation has no Triage status, so there's nothing to triage. An admin can add one under Settings → Statuses with the Triage stage."),
            json({ kind: "idle", waitingInTriage: 0 }),
          ],
        };
      }
      for (const [i, t] of tasks.entries()) {
        try {
          await c.agentClaims.insertOne({ _id: new ObjectId(), orgId: ctx.org._id, botId: ctx.bot._id, taskId: t._id, kind: "triage", state: "in_progress", claimedAt: new Date(), finishedAt: null });
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
          `Triage ${key} "${task.title}" in project ${project.name}. It's now being triaged by you; no other bot will be handed it. Break it down into the actual tasks needed to do the job and wire up their dependencies so the work happens in a logical order:\n\n${TRIAGE_STEPS(key)}`,
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
      "Open tasks assigned to you, plus tasks you've picked up and not finished. `yourState` is in_progress, done or null (not picked up yet). `ready` is false while a task it depends on isn't done (`waitingOn` lists them); check_for_work offers those once they're ready.",
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
      return { content: [json({ tasks: await summarise(ctx, tasks as TaskDoc[]) })] };
    },
  },

  complete_task: {
    description:
      "Say you've finished your work on a task. Optionally post a final comment and move it to a status. Use Done when the work meets its acceptance criteria: only a done (or cancelled) status releases the tasks that depend on it. In Review leaves them waiting until a person closes it, so use it only when a person really has to check or decide something, and @mention that person in the comment. The task won't be offered again by check_for_work unless someone assigns it to you afresh. Mentions on it still reach you. For a task you're triaging, this ends the triage: pass a `status` that moves it out of Triage. You stay its triager afterwards: once everything it depends on is done you're called back (push wake-up, or `kind: \"closeout\"` on check_for_work) and close it out with complete_task and a closing status (e.g. Done, or In Review if something was cancelled or left open).",
    inputSchema: {
      type: "object",
      properties: {
        task: TASK_ARG,
        comment: { type: "string", description: "Optional closing comment, e.g. a summary of what you did. Mention people with <@id>." },
        status: { type: "string", description: "Optional status name to move the task to (needs you to be its creator or assignee; as its triager, a closing status once it's ready)." },
      },
      required: ["task"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const { task, project } = await findTask(ctx, str(args, "task", true)!);
      const status = str(args, "status");
      const comment = str(args, "comment");
      if (status) await updateTaskAs(ctx.actor, task._id, { statusId: (await resolveStatus(ctx, status))._id.toHexString() });
      if (comment) await addCommentAs(ctx.actor, task._id, comment);
      const c = await cols();
      const now = new Date();
      const claim = await c.agentClaims.findOne({ botId: ctx.bot._id, taskId: task._id });
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
        return { content: [text(`Finished triaging ${key}.${status ? ` Moved to ${status}.` : ""}${comment ? " Comment posted." : ""}`)] };
      }
      await c.agentClaims.updateOne(
        { botId: ctx.bot._id, taskId: task._id },
        { $set: { state: "done", finishedAt: now }, $setOnInsert: { _id: new ObjectId(), orgId: ctx.org._id, claimedAt: now } },
        { upsert: true },
      );
      if (claim?.state === "in_progress") await publishWorking(ctx.org._id, ctx.bot._id, [task._id]);
      const key = `${project.key}-${task.number}`;
      const handoff = await reviewHandoff(ctx, task._id, key, comment);
      return { content: [text(`Marked your work on ${key} as finished.${status ? ` Moved to ${status}.` : ""}${comment ? " Comment posted." : ""}${handoff}`)] };
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

  get_task: {
    readOnly: true,
    description: "Everything about one task: project, status, priority, assignee, due date, description (Markdown), images (attached inline), every comment and the activity history. Doesn't change any state.",
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
        status: { type: "string", description: "Status name or id." },
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
      if (status) filter.statusId = (await resolveStatus(ctx, status))._id;
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
    description: "Who you are, the tools your role allows, and the organisation's projects (with each project's context: admin-set key/value notes such as repos and conventions), statuses (in workflow order) and people and bots with their ids, for assigning and @mentioning.",
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
    description: "Move a task to another status, by name (see get_workspace for the workflow). Works on tasks you created or are assigned to. On a task you triaged, you can move it to a closing status (e.g. Done, In Review or Cancelled) once nothing it depends on is open.",
    inputSchema: { type: "object", properties: { task: TASK_ARG, status: { type: "string", description: 'Status name, e.g. "In Progress".' } }, required: ["task", "status"], additionalProperties: false },
    run: async (args, ctx) => {
      const { task } = await findTask(ctx, str(args, "task", true)!);
      const st = await resolveStatus(ctx, str(args, "status", true)!);
      const t = await updateTaskAs(ctx.actor, task._id, { statusId: st._id.toHexString() });
      return { content: [text(`${t.key} is now ${st.name}.`)] };
    },
  },

  assign_task: {
    description:
      'Assign a task to a person or bot (name, email or id), to yourself ("me"), or to nobody (null or "none"). Works on tasks you created or are assigned to. Once you hand a task you didn\'t create to someone else, you can only comment on it, so set its status first.',
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
      return { content: [text(id ? `${t.key} is now assigned to ${dir.get(id)?.name ?? id}.` : `${t.key} is now unassigned.`)] };
    },
  },

  update_task: {
    description:
      "Edit a task. On tasks you created you can change anything. On tasks assigned to you, priority, type and due date. Title, description, project, dependencies and archiving are creator-only. Description accepts Markdown and replaces the whole description. `depends_on` replaces the whole dependency list ([] removes them all).",
    inputSchema: {
      type: "object",
      properties: {
        task: TASK_ARG,
        title: { type: "string" },
        description: { type: "string", description: "Markdown. Replaces the existing description." },
        type: { type: "string", enum: ["issue", "feature"] },
        priority: { type: "string", enum: ["none", "low", "medium", "high"] },
        due_date: { type: ["string", "null"], description: "YYYY-MM-DD, or null to clear." },
        project: { type: "string", description: "Move to another project (key, name or id). The task gets a new key." },
        archived: { type: "boolean" },
        depends_on: DEPENDS_ARG,
      },
      required: ["task"],
      additionalProperties: false,
    },
    run: async (args, ctx) => {
      const { task } = await findTask(ctx, str(args, "task", true)!);
      const patch: TaskPatch = {
        title: str(args, "title"),
        description: args.description === undefined ? undefined : markdownToHtml(String(args.description ?? "")),
        type: parseType(args.type),
        priority: parsePriority(args.priority),
        dueDate: args.due_date === undefined ? undefined : args.due_date === null || args.due_date === "" ? null : String(args.due_date),
        projectId: str(args, "project") ? (await resolveProject(ctx, str(args, "project")!))._id.toHexString() : undefined,
        archived: typeof args.archived === "boolean" ? args.archived : undefined,
        dependsOn: args.depends_on === undefined ? undefined : await resolveTaskIds(ctx, args.depends_on, "depends_on"),
      };
      if (Object.values(patch).every((v) => v === undefined)) throw new ToolInputError("Pass at least one field to change.");
      const t = await updateTaskAs(ctx.actor, task._id, patch);
      return { content: [text(`Updated ${t.key}.`), json({ key: t.key, url: taskUrl(ctx.origin, ctx.org, t.key) })] };
    },
  },

  create_task: {
    description:
      "Create a task in a project. You become its creator, so you can edit it fully later. Description accepts Markdown. Use `depends_on` to chain work: e.g. create \"Log in\", then \"Create sandbox data\" depending on it, then \"Export report\" depending on that. Each assignee is handed their task only when everything it depends on is done.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project key (WEB), name or id." },
        title: { type: "string" },
        description: { type: "string", description: "Markdown." },
        type: { type: "string", enum: ["issue", "feature"], default: "issue" },
        status: { type: "string", description: "Status name. Defaults to the first not-started status." },
        assignee: { type: "string", description: 'Name, email, id or "me". Leave out for unassigned.' },
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
        statusId: status ? (await resolveStatus(ctx, status))._id.toHexString() : undefined,
        assigneeId: assignee ? resolvePerson(await loadDirectory(ctx.org._id), ctx.bot._id, assignee) : null,
        priority: parsePriority(args.priority),
        description: args.description === undefined ? undefined : markdownToHtml(String(args.description)),
        dueDate: str(args, "due_date") ?? null,
        dependsOn: args.depends_on === undefined ? undefined : await resolveTaskIds(ctx, args.depends_on, "depends_on"),
      });
      const waiting = t.waitingOn.length ? await taskKeys(ctx.org._id, t.waitingOn.map((id) => new ObjectId(id))) : null;
      const note = waiting ? ` It waits on ${[...waiting.values()].join(", ")} and is handed to its assignee once ${waiting.size === 1 ? "that is" : "those are"} done.` : "";
      return {
        content: [text(`Created ${t.key} "${t.title}".${note}`), json({ key: t.key, id: t.id, url: taskUrl(ctx.origin, ctx.org, t.key), ready: !waiting, waitingOn: waiting ? [...waiting.values()] : [] })],
      };
    },
  },
};

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
    return { isError: true, content: [text(`${ctx.bot.name}'s bot role doesn't allow ${name}. Ask an admin to change the role under Settings → Bot roles.`)] };
  }
  try {
    return await impl.run(args ?? {}, ctx);
  } catch (err) {
    if (err instanceof ToolInputError || err instanceof UserError) return { isError: true, content: [text(err.message)] };
    console.error(`[mcp] ${name}`, err);
    return { isError: true, content: [text("Something went wrong on the Vector side. Try again.")] };
  }
}

export const SERVER_INSTRUCTIONS = `You are a bot in a Vector issue tracker organisation. People assign you tasks and @mention you in comments.
Typical loop: call check_for_work. It returns one item at a time:
- kind "mention": someone tagged you in a comment. Read the task and thread, then reply with add_comment.
- kind "closeout": a task you triaged whose sub-tasks are all done. Summarise what they delivered with add_comment, then complete_task it with Done (or In Review if something was cancelled or left open).
- kind "assigned": a task assigned to you, now picked up by you. Do the work, post progress with add_comment, move it with set_status, hand it on with assign_task, then call complete_task.
- kind "idle": nothing new.
Call check_for_work again until it says idle. Use get_workspace for project keys, statuses and people's ids.
If your role allows check_for_triage, you're also a triage bot: call it on your schedule. Each call hands you one task waiting in the Triage status (no other bot gets it); break it into concrete tasks with create_task, chain them with \`depends_on\` so they run in a logical order, make the original depend on them, then complete_task it with a status that moves it out of Triage. When those tasks are all done, check_for_work hands you the original back as kind "closeout": summarise what was delivered with add_comment, then complete_task it with Done (or In Review if something was cancelled or left open).
Tasks can depend on other tasks (\`depends_on\` on create_task / update_task). A task isn't offered or pushed to its assignee until everything it depends on is closed (a done or cancelled status; the ready message says which were cancelled); moving your task to a done or cancelled status (set_status or complete_task with a status) releases the tasks waiting on it.\nComments are plain text: write add_comment and complete_task comments without Markdown (no **bold**, headings or tables); plain "- " lists are fine. Task descriptions do accept Markdown.`;
