import "server-only";
import { ObjectId, type Filter } from "mongodb";
import sanitizeHtml from "sanitize-html";
import { cols } from "@/lib/db";
import type {
  ActivityDoc,
  CommentDoc,
  Counts,
  FeedItem,
  Member,
  Project,
  ProjectDoc,
  Status,
  StatusDoc,
  Task,
  TaskDetail,
  TaskDoc,
} from "@/lib/types";

export const DEFAULT_STATUSES: Omit<StatusDoc, "_id" | "orgId">[] = [
  { name: "Backlog", color: "#a3a3a3", category: "backlog", order: 0 },
  { name: "Todo", color: "#737373", category: "unstarted", order: 1 },
  { name: "In Progress", color: "#e5a00d", category: "started", order: 2 },
  { name: "In Review", color: "#8b5cf6", category: "started", order: 3 },
  { name: "Done", color: "#2f6fed", category: "done", order: 4 },
  { name: "Cancelled", color: "#a3a3a3", category: "cancelled", order: 5 },
];

export const PROJECT_COLORS = ["#2f6fed", "#30a46c", "#e5a00d", "#8b5cf6", "#e5484d", "#0ea5b7", "#d6409f", "#737373"];

export const toProject = (p: ProjectDoc): Project => ({ id: p._id.toHexString(), name: p.name, key: p.key, color: p.color });
export const toStatus = (s: StatusDoc): Status => ({
  id: s._id.toHexString(),
  name: s.name,
  color: s.color,
  category: s.category,
  order: s.order,
});

export function toTask(t: TaskDoc, projectKey: string): Task {
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
    createdBy: t.createdBy.toHexString(),
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
export const toTaskDetail = (t: TaskDoc, projectKey: string): TaskDetail => ({
  ...toTask(t, projectKey),
  description: t.description,
});

export function toFeed(doc: CommentDoc | ActivityDoc): FeedItem {
  if ("body" in doc) {
    return { id: doc._id.toHexString(), kind: "comment", actorId: doc.authorId.toHexString(), body: doc.body, createdAt: doc.createdAt.toISOString() };
  }
  return {
    id: doc._id.toHexString(),
    kind: doc.kind,
    actorId: doc.actorId.toHexString(),
    from: doc.from ?? null,
    to: doc.to ?? null,
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
    transformTags: { a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }) },
  }).slice(0, 200_000);
}

/* ---------------- shell data ---------------- */

export async function loadShell(orgId: ObjectId, userId: ObjectId) {
  const c = await cols();
  const [projects, statuses, memberships] = await Promise.all([
    c.projects.find({ orgId }).sort({ createdAt: 1 }).toArray(),
    c.statuses.find({ orgId }).sort({ order: 1 }).toArray(),
    c.memberships.find({ orgId }).toArray(),
  ]);
  const users = await c.users
    .find({ _id: { $in: memberships.map((m) => m.userId) } }, { projection: { passwordHash: 0 } })
    .toArray();
  const byId = new Map(users.map((u) => [u._id.toHexString(), u]));
  const members: Member[] = memberships
    .map((m) => {
      const u = byId.get(m.userId.toHexString());
      return u ? { id: u._id.toHexString(), name: u.name, email: u.email, role: m.role } : null;
    })
    .filter((m): m is Member => !!m)
    .sort((a, b) => a.name.localeCompare(b.name));
  const counts = await loadCounts(orgId, userId, statuses);
  return { projects: projects.map(toProject), statuses: statuses.map(toStatus), members, counts };
}

export async function loadCounts(orgId: ObjectId, userId: ObjectId, statuses?: StatusDoc[]): Promise<Counts> {
  const c = await cols();
  statuses ??= await c.statuses.find({ orgId }).toArray();
  const openIds = statuses.filter((s) => s.category !== "done" && s.category !== "cancelled").map((s) => s._id);
  const rows = await c.tasks
    .aggregate<{ _id: ObjectId; n: number; mine: number }>([
      { $match: { orgId, statusId: { $in: openIds } } },
      { $group: { _id: "$projectId", n: { $sum: 1 }, mine: { $sum: { $cond: [{ $eq: ["$assigneeId", userId] }, 1, 0] } } } },
    ])
    .toArray();
  const projects: Record<string, number> = {};
  let all = 0;
  let my = 0;
  for (const r of rows) {
    projects[r._id.toHexString()] = r.n;
    all += r.n;
    my += r.mine;
  }
  return { my, all, projects };
}

/* ---------------- tasks ---------------- */

export interface TaskScope {
  projectId?: string;
  assigneeId?: string;
}

export async function listTasks(orgId: ObjectId, scope: TaskScope): Promise<Task[]> {
  const c = await cols();
  const filter: Filter<TaskDoc> = { orgId };
  if (scope.projectId) filter.projectId = new ObjectId(scope.projectId);
  if (scope.assigneeId) filter.assigneeId = new ObjectId(scope.assigneeId);
  const [docs, projects] = await Promise.all([
    c.tasks.find(filter, { projection: { description: 0 } }).sort({ updatedAt: -1 }).limit(2000).toArray(),
    c.projects.find({ orgId }, { projection: { key: 1 } }).toArray(),
  ]);
  const keys = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
  return docs.map((d) => toTask(d as TaskDoc, keys.get(d.projectId.toHexString()) ?? "?"));
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
