import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { readLocalImage, MAX_IMAGE_BYTES } from "@/lib/storage";
import { projectContext, toTask, withWorkingBots } from "@/lib/data";
import { loadTaskRefs } from "@/lib/dependencies";
import { botTaskFlow } from "@/lib/flow-bot-view";
import { isParked, parkedReason } from "@/lib/flow-engine";
import { botNewTaskViews } from "@/lib/project-defaults";
import { taskUrl as orgTaskUrl } from "@/lib/paths";
import { DELETED_USER_NAME, loadDeletedUserIds } from "@/lib/deleted-users";
import { isBotEnabled } from "@/lib/bot-enabled";
import { decodeEntities as decode, htmlToMarkdown, markdownToHtml } from "@/lib/markdown-core";
import { commentImages } from "@/lib/comment-images";
import { isClosedCategory, type ActivityDoc, type BotDoc, type OrgDoc, type ProjectDoc, type StatusDoc, type TaskDoc, type TaskRef } from "@/lib/types";

/* ---------------- people directory ---------------- */

export interface Person {
  id: string;
  name: string;
  kind: "user" | "bot";
  email?: string;
  role?: string;
  description?: string;
  /** VEC-344: a disabled bot. Kept so its name resolves on old tasks; left out of what agents are listed. */
  disabled?: boolean;
}

/**
 * People and bots by id. `deleted` holds deleted accounts (VEC-48) that can still appear in old tasks,
 * comments and activity: they aren't entries, so nothing can assign or mention them, but names resolve to
 * "Deleted user" rather than "Former member".
 */
export class Directory extends Map<string, Person> {
  deleted = new Set<string>();
}

/** Name for an id that may belong to someone no longer in the org (left, or account deleted). */
export function personName(dir: Map<string, Person>, id: ObjectId | string, gone = "Former member"): string {
  const hex = typeof id === "string" ? id : id.toHexString();
  const p = dir.get(hex);
  if (p) return p.name;
  return dir instanceof Directory && dir.deleted.has(hex) ? DELETED_USER_NAME : gone;
}

/** Everyone a task can be assigned to or mention: members and bots of the org. */
export async function loadDirectory(orgId: ObjectId): Promise<Directory> {
  const c = await cols();
  const [memberships, bots, deleted] = await Promise.all([
    c.memberships.find({ orgId }).toArray(),
    c.bots.find({ orgId }).toArray(),
    loadDeletedUserIds(orgId),
  ]);
  const users = await c.users.find({ _id: { $in: memberships.map((m) => m.userId) } }, { projection: { passwordHash: 0 } }).toArray();
  const roles = new Map(memberships.map((m) => [m.userId.toHexString(), m.role]));
  const out = new Directory();
  for (const id of deleted) out.deleted.add(id);
  for (const u of users) out.set(u._id.toHexString(), { id: u._id.toHexString(), name: u.name, kind: "user", email: u.email, role: roles.get(u._id.toHexString()) });
  for (const b of bots) out.set(b._id.toHexString(), { id: b._id.toHexString(), name: b.name, kind: "bot", description: b.description || undefined, ...(isBotEnabled(b) ? {} : { disabled: true }) });
  return out;
}

const personRef = (dir: Map<string, Person>, id: ObjectId | string | null | undefined) => {
  if (!id) return null;
  const hex = typeof id === "string" ? id : id.toHexString();
  const p = dir.get(hex);
  return p ? { id: p.id, name: p.name, kind: p.kind } : { id: hex, name: personName(dir, hex), kind: "user" as const };
};

/** "me", an id, an email or a name (case-insensitive) -> person id. */
export function resolvePerson(dir: Map<string, Person>, botId: ObjectId, ref: string): string {
  const s = ref.trim().replace(/^@/, "");
  if (s.toLowerCase() === "me") return botId.toHexString();
  if (dir.has(s)) return s;
  const lower = s.toLowerCase();
  let hits = [...dir.values()].filter((p) => p.email?.toLowerCase() === lower || p.name.toLowerCase() === lower);
  // Fall back to a first name ("Mia" for "Mia Chen") when it's unambiguous.
  if (!hits.length) hits = [...dir.values()].filter((p) => p.name.toLowerCase().split(/\s+/)[0] === lower);
  if (hits.length === 1) return hits[0].id;
  if (hits.length > 1) throw new ToolInputError(`"${ref}" matches ${hits.length} people (${hits.map((h) => `${h.name} ${h.id}`).join(", ")}). Use an id.`);
  throw new ToolInputError(`No member or bot called "${ref}". Call get_workspace for the list of people and bots.`);
}

export class ToolInputError extends Error {}

/* ---------------- HTML <-> Markdown ---------------- */

// Pure helpers in lib/markdown-core.ts (unit-tested there); text is escaped so typed markup stays text (VEC-243).
export { htmlToMarkdown, markdownToHtml };

/* ---------------- images ---------------- */

export interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

const MAX_IMAGES = 8;

/** Loads images the org owns (local uploads or its Vercel Blob files). Other URLs are listed, never fetched. */
async function loadImage(orgHex: string, src: string): Promise<ImageBlock | null> {
  const local = /^\/api\/uploads\/([^/?#]+)$/.exec(src);
  if (local) {
    if (!local[1].startsWith(`${orgHex}-`)) return null;
    const img = await readLocalImage(local[1]);
    return img ? { type: "image", data: img.data.toString("base64"), mimeType: img.type } : null;
  }
  if (/^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/uploads\//.test(src) && src.includes(`/uploads/${orgHex}-`)) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(10_000) });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !type.startsWith("image/")) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength > MAX_IMAGE_BYTES) return null;
      return { type: "image", data: buf.toString("base64"), mimeType: type.split(";")[0] };
    } catch {
      return null;
    }
  }
  return null;
}

/* ---------------- task context ---------------- */

export const PRIORITY_LABEL = ["none", "low", "medium", "high"] as const;

export const taskUrl = (origin: string, org: OrgDoc, key: string) => orgTaskUrl(origin, org.slug, key);

const renderBody = (body: string, dir: Map<string, Person>) => body.replace(/<@([a-f0-9]{24})>/g, (_, id: string) => `@${personName(dir, id, "former member")}`);

export interface TaskContextOptions {
  origin: string;
  org: OrgDoc;
  bot: BotDoc;
  includeImages?: boolean;
  /** Comments to flag as new for this delivery. */
  highlight?: ObjectId[];
  dir?: Map<string, Person>;
  statuses?: StatusDoc[];
}

/** Everything an agent needs about one task: metadata, project, description, images, comments, activity, its own state. */
export async function buildTaskContext(task: TaskDoc, project: ProjectDoc, opts: TaskContextOptions) {
  const c = await cols();
  const { org, bot } = opts;
  const [dir, statuses, comments, activity, claim, projects, refs] = await Promise.all([
    opts.dir ?? loadDirectory(org._id),
    opts.statuses ?? c.statuses.find({ orgId: org._id }).sort({ order: 1 }).toArray(),
    c.comments.find({ taskId: task._id }).sort({ createdAt: 1 }).limit(500).toArray(),
    c.activity.find({ taskId: task._id }).sort({ createdAt: 1 }).limit(500).toArray(),
    c.agentClaims.findOne({ botId: bot._id, taskId: task._id }),
    c.projects.find({ orgId: org._id }, { projection: { key: 1, name: 1 } }).toArray(),
    loadTaskRefs(org._id, task),
  ]);
  const statusById = new Map(statuses.map((s) => [s._id.toHexString(), s]));
  const ownStatuses = statuses.filter((s) => s.projectId.equals(project._id));
  const newTasks = (await botNewTaskViews(org._id, [project], new Map([[project._id.toHexString(), ownStatuses]]))).get(project._id.toHexString()) ?? null;
  const projectKey = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
  const status = statusById.get(task.statusId.toHexString());
  const key = `${project.key}-${task.number}`;
  const highlight = new Set((opts.highlight ?? []).map((id) => id.toHexString()));

  const description = htmlToMarkdown(task.description);
  const srcs = [...task.description.matchAll(/<img\b[^>]*\ssrc="([^"]+)"/gi)].map((m) => decode(m[1]));
  const orgHex = org._id.toHexString();
  const images: { index: number; url: string; attached: boolean }[] = [];
  const blocks: ImageBlock[] = [];
  for (const [i, src] of srcs.entries()) {
    const block = opts.includeImages !== false && blocks.length < MAX_IMAGES ? await loadImage(orgHex, src) : null;
    if (block) blocks.push(block);
    images.push({ index: i + 1, url: src.startsWith("/") ? `${opts.origin}${src}` : src, attached: !!block });
  }
  // Comment images (VEC-335): this org's uploads only, attached after the description's within the same cap.
  const commentImageList = new Map<string, { url: string; attached: boolean }[]>();
  for (const cm of comments) {
    const own = commentImages(cm.body, orgHex);
    if (!own.length) continue;
    const list: { url: string; attached: boolean }[] = [];
    for (const { src } of own) {
      const block = opts.includeImages !== false && blocks.length < MAX_IMAGES ? await loadImage(orgHex, src) : null;
      if (block) blocks.push(block);
      list.push({ url: src.startsWith("/") ? `${opts.origin}${src}` : src, attached: !!block });
    }
    commentImageList.set(cm._id.toHexString(), list);
  }

  const describe = (a: ActivityDoc) => {
    const name = (id?: string | null) => (id ? personRef(dir, id)!.name : "nobody");
    const st = (id?: string | null) => (id ? statusById.get(id)?.name ?? "a deleted status" : "none");
    const pr = (v?: string | null) => PRIORITY_LABEL[Number(v)] ?? v;
    switch (a.kind) {
      case "created": return a.note === "form" ? `submitted it via the external form "${a.to ?? (task.source?.kind === "form" ? task.source.formName : "?")}"` : a.note === "public" ? "submitted it on the project's public page" : "created the task";
      case "status": return `moved it from ${st(a.from)} to ${st(a.to)}${a.note === "started_work" ? " (started work)" : a.note === "resumed_work" ? " (back to work after a mention)" : a.note === "stopped_work" ? " (stopped the bot's work)" : ""}`;
      case "assignee": return a.to ? `assigned it to ${name(a.to)}${a.note === "auto_owner" ? ` (nobody owned it and ${a.waiter ?? "a task it assigned to itself"} was waiting on it)` : ""}` : `unassigned ${name(a.from)}`;
      case "priority": return `changed priority from ${pr(a.from)} to ${pr(a.to)}`;
      case "type": return `changed type from ${a.from} to ${a.to}`;
      case "title": return `renamed it from "${a.from}" to "${a.to}"`;
      case "project": return `moved it from ${projectKey.get(a.from ?? "") ?? "another project"} to ${projectKey.get(a.to ?? "") ?? "another project"}`;
      case "due": return a.to ? `set the due date to ${a.to}` : "cleared the due date";
      case "archived": return "archived it";
      case "restored": return "restored it from the archive";
      case "dependency_added": return `made it depend on ${a.to ?? "another task"}`;
      case "dependency_removed": return `removed its dependency on ${a.to ?? "another task"}`;
      case "retried": return `asked ${name(a.to)} to ${a.note === "closeout" ? "retry the close-out" : "retry it (its earlier run stopped)"}`;
      case "stopped": return `stopped ${name(a.to)}'s ${a.note === "triage" ? "triage" : "work"} on it (paused until resumed)`;
      case "resumed": return a.to ? `resumed it and handed it back to ${name(a.to)}` : "resumed it";
      case "unblocked": return a.from ? `closed ${a.from}, so it became ready to work on` : "cleared what it was waiting on, so it became ready to work on";
      case "flow_step": return flowStepText(a.note, a.from, a.to, a.flowStatus, a.flowOwner ? name(a.flowOwner) : null);
    }
  };

  const refOut = (t: TaskRef) => {
    const s = statusById.get(t.statusId);
    return { key: t.key, title: t.title, status: s?.name ?? null, done: s?.category === "done", assignee: t.assigneeId ? personRef(dir, t.assigneeId)?.name ?? null : null, url: taskUrl(opts.origin, org, t.key) };
  };
  const waiting = refs.dependencies.filter((d) => !isClosedCategory(statusById.get(d.statusId)?.category));
  const [{ stalled }] = await withWorkingBots([toTask(task, project.key)]);
  const stalledOut = stalled
    ? {
        reason:
          stalled.reason === "finished"
            ? `${personRef(dir, stalled.botId)?.name ?? "Its bot"} finished its work but left it open`
            : stalled.reason === "unfinished"
            ? `${personRef(dir, stalled.botId)?.name ?? "Its bot"} ended its run without calling complete_task, twice (Aimpoint sent one follow-up), so nothing moved it on`
            : stalled.reason === "undelivered"
            ? `Aimpoint couldn't deliver the hand-off to ${personRef(dir, stalled.botId)?.name ?? "its bot"} after several retries, so nobody is working on it`
            : stalled.reason === "needs_owner"
              ? "nobody is assigned yet; it is still waiting on its own dependencies, so it isn't holding anything up yet, but it needs an owner before they're done"
              : "nobody is assigned",
        /** "stalled": holding the blocking tasks up now. "needs_owner": a softer hint, not stalled yet. */
        kind: stalled.reason === "needs_owner" ? "needs_owner" : "stalled",
        blocking: stalled.blocking,
      }
    : null;
  const dependencies = {
    /** False while anything in `dependsOn` is still open (not done or cancelled). Don't start work on a task that isn't ready. */
    ready: waiting.length === 0,
    waitingOn: waiting.map((d) => d.key),
    /** Tasks that must be done before this one. Their comments often hold results this task builds on. */
    dependsOn: refs.dependencies.map(refOut),
    /** Tasks waiting for this one. Moving this task to a done status releases them to their assignees. */
    blocks: refs.dependents.map(refOut),
    /** Set when open tasks wait on this one and nobody is moving it: unassigned, or its bot finished but left it open (or, waiters or not, Aimpoint couldn't deliver the hand-off to its bot). People see it flagged as stalled. kind "needs_owner" = unassigned but still waiting on its own dependencies: people see a neutral "Needs owner" hint, not Stalled. */
    stalled: stalledOut,
    /** Parked in a backlog-stage status (VEC-274): not work yet, so it isn't handed out or started. Null otherwise. */
    parked: await (async () => {
      const own = statusById.get(task.statusId.toHexString());
      return own && (await isParked(task, own.category)) ? { reason: parkedReason(own.name) } : null;
    })(),
  };

  // Where it is in its project's flow (VEC-176): the step, its instructions, what comes next and who has it.
  const flow = await botTaskFlow(task, project.key, task.assigneeId ? personRef(dir, task.assigneeId)!.name : null);

  const isCreator = task.createdBy.equals(bot._id);
  const isAssignee = !!task.assigneeId?.equals(bot._id);
  const triaging = claim?.kind === "triage" && claim.state === "in_progress";
  const triaged = !!task.triagedBy?.equals(bot._id);

  const data = {
    key,
    id: task._id.toHexString(),
    url: taskUrl(opts.origin, org, key),
    title: task.title,
    type: task.type,
    status: status ? { name: status.name, stage: status.category } : null,
    priority: PRIORITY_LABEL[task.priority],
    dueDate: task.dueDate ? task.dueDate.toISOString().slice(0, 10) : null,
    archived: !!task.archivedAt,
    /**
     * VEC-216: a person stopped a bot's work on this task (`by`, `at`), and it stays paused until they resume it.
     * `you` true = it was your work: don't continue; Aimpoint refuses your changes to it (and to tasks linking to it)
     * meanwhile, except a reply to a mention made after the stop. Resume hands it back with a fresh wake-up.
     */
    stopped: task.stopped
      ? {
          by: personRef(dir, task.stopped.by),
          at: task.stopped.at.toISOString(),
          bot: personRef(dir, task.stopped.botId),
          kind: task.stopped.kind,
          you: task.stopped.botId.equals(bot._id),
          note: task.stopped.botId.equals(bot._id)
            ? `${personRef(dir, task.stopped.by)?.name ?? "A person"} stopped your ${task.stopped.kind === "triage" ? "triage of" : "work on"} ${key}; don't continue. Your changes to it are refused until they resume it, which hands it back to you.`
            : `${personRef(dir, task.stopped.by)?.name ?? "A person"} stopped ${personRef(dir, task.stopped.botId)?.name ?? "a bot"}'s ${task.stopped.kind === "triage" ? "triage" : "work"} on ${key}; it's paused until they resume it.`,
        }
      : null,
    dependencies,
    /**
     * The task's place in its project's flow (null = the project has no flow). `step` = the step it's at (owner,
     * instructions, how it moves on), `next` = where complete_task without a status sends it and who gets it,
     * `holder` = who has it now, `howToFinish` = what to call when this step's work is done, `steps` = the pipeline.
     * `active` false = the flow says nothing here (the seeded default): finish with a status as usual.
     */
    flow,
    /**
     * `context` is the project's admin-set key/value metadata: repos, environments, conventions and the like.
     * `statuses` is this project's own workflow in order (statuses are per project): the only names set_status,
     * update_task and complete_task accept for this task. `stage` is what Aimpoint acts on: a done or cancelled
     * stage releases the tasks waiting on it, started = being worked on, unstarted = planned. `newTasks` (read-only,
     * VEC-190) = where a person's new task with no status lands here: `source` "project" (this project's override),
     * "org" (the org default stage) or "fallback"; tasks bots create without a status start in the first not-started one.
     */
    project: {
      id: project._id.toHexString(),
      key: project.key,
      name: project.name,
      archived: !!project.archivedAt,
      context: projectContext(project),
      statuses: ownStatuses.map((s) => ({ name: s.name, stage: s.category })),
      newTasks,
    },
    organisation: { id: orgHex, name: org.name, slug: org.slug },
    assignee: personRef(dir, task.assigneeId),
    /** The bot that broke this task down in Triage. It may close it out once nothing it depends on is open. */
    triagedBy: personRef(dir, task.triagedBy ?? null),
    /** For a form-submitted task (see `source`) this is the form itself, kind "form". */
    createdBy:
      task.source?.kind === "public"
        ? { id: task.createdBy.toHexString(), name: `${task.source.userName} (public submission)`, kind: "public" as const }
        : task.source
          ? { id: task.createdBy.toHexString(), name: `${task.source.formName} (external form)`, kind: "form" as const }
          : personRef(dir, task.createdBy),
    /**
     * Where the task came from when nobody in the org created it (VEC-208). null = created normally by a member or
     * bot. kind "form": submitted through one of the project's external forms by someone outside the org, so
     * `submitter` (name/email as they typed them, either may be null) is the reporter to credit or follow up with;
     * they can't see this task or its comments. kind "public" (VEC-255): filed on the project's public page by a
     * signed-in Aimpoint account that may not be in the org; `submitter.name` is its display name (no email). They
     * can read the project's public view but can't edit the task.
     */
    source:
      task.source?.kind === "public"
        ? { kind: "public" as const, submitter: { name: task.source.userName } }
        : task.source
      ? {
          kind: task.source.kind,
          form: { id: task.source.formId.toHexString(), name: task.source.formName },
          submitter: { name: task.source.submitterName ?? null, email: task.source.submitterEmail ?? null },
        }
      : null,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    description,
    images,
    comments: comments.map((cm) => ({
      id: cm._id.toHexString(),
      author: personRef(dir, cm.authorId),
      body: renderBody(cm.body, dir),
      mentions: (cm.mentions ?? []).map((m) => personRef(dir, m)),
      mentionsYou: !!cm.mentions?.some((m) => m.equals(bot._id)),
      images: commentImageList.get(cm._id.toHexString()),
      new: highlight.has(cm._id.toHexString()) || undefined,
      createdAt: cm.createdAt.toISOString(),
    })),
    activity: activity.map((a) => ({
      actor:
        a.kind === "created" && a.note === "public" && task.source?.kind === "public"
          ? task.source.userName
          : a.kind === "created" && a.note === "form" && task.source?.kind === "form"
            ? task.source.submitterName || task.source.submitterEmail || "Someone outside the org"
            : personRef(dir, a.actorId)?.name,
      change: describe(a),
      at: a.createdAt.toISOString(),
    })),
    you: {
      assigned: isAssignee,
      createdThisTask: isCreator,
      /** You finished triaging this task, so closing it out once it's ready is yours. */
      triaged,
      pickedUp: claim ? { as: claim.kind ?? "assigned", state: claim.state, at: claim.claimedAt.toISOString() } : null,
      /**
       * Same rule as people: creator = everything, assignee = status/assignee/priority/type/due date, anyone else = comment only.
       * "triage" = you're triaging it: everything except archiving, until complete_task or release_task.
       * "close-out" = you triaged it: comment, and move it to a closing status (done, cancelled or a review status) once it's ready.
       */
      access: isCreator ? "full" : triaging ? "triage" : isAssignee ? "assignee" : triaged ? "close-out" : "comment",
    },
  };
  return { data, images: blocks, key };
}

/** A flow_step activity line (VEC-175), e.g. "moved it to In Review and handed it to Testing Verification by flow (Develop -> Test)". */
export function flowStepText(note: string | undefined, from: string | null | undefined, to: string | null | undefined, status: string | null | undefined, owner: string | null) {
  const where = status ?? to ?? "the next step";
  const steps = from ? `${from} -> ${to}` : `${to}`;
  if (note === "umbrella") return `split it into sub-tasks, so its flow is paused while they run (it moved to ${where})`;
  if (note === "paused") return `paused its flow${from ? ` at ${from}` : ""}`;
  if (note === "resumed") return to ? `resumed its flow at the ${to} step (${where})` : "resumed its flow (its status is none of the flow's steps)";
  if (note === "back") return `sent it back to ${where}${owner ? ` and handed it to ${owner}` : ""} by flow (${steps})`;
  if (note === "advanced") return `moved it to ${where}${owner ? ` and handed it to ${owner}` : ""} by flow (${steps})`;
  return `put it at the ${to} step of its flow (${where})${owner ? `, owned by ${owner}` : ""}`;
}
