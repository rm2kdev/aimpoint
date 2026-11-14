import { ObjectId, type Filter } from "mongodb";
import {
  botRoute,
  parsePriority,
  parseType,
  readJson,
  resolveAssignee,
  resolveProject,
  resolveStatus,
  toDescriptionHtml,
} from "@/lib/bot-api";
import { cols } from "@/lib/db";
import { toTask } from "@/lib/data";
import { createTaskAs } from "@/lib/task-service";
import type { TaskDoc } from "@/lib/types";

/** GET /api/v1/tasks?project=WEB&assignee=me&status=Todo&archived=true&limit=50  (archived tasks are excluded unless archived=true) */
export const GET = botRoute(async (req, ctx) => {
  const q = new URL(req.url).searchParams;
  const filter: Filter<TaskDoc> = { orgId: ctx.org._id, archivedAt: q.get("archived") === "true" ? { $ne: null } : null };
  if (q.get("project")) filter.projectId = (await resolveProject(ctx.org._id, q.get("project")))._id;
  const status = await resolveStatus(ctx.org._id, q.get("status"));
  if (status) filter.statusId = new ObjectId(status);
  const assignee = await resolveAssignee(ctx, q.get("assignee") ?? undefined);
  if (assignee !== undefined) filter.assigneeId = assignee ? new ObjectId(assignee) : null;
  const limit = Math.min(Math.max(Number(q.get("limit")) || 50, 1), 200);
  const c = await cols();
  const [docs, projects] = await Promise.all([
    c.tasks.find(filter, { projection: { description: 0 } }).sort({ updatedAt: -1 }).limit(limit).toArray(),
    c.projects.find({ orgId: ctx.org._id }).toArray(),
  ]);
  const keys = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
  return { tasks: docs.map((d) => toTask(d as TaskDoc, keys.get(d.projectId.toHexString()) ?? "?")) };
});

/** POST /api/v1/tasks  { title, project, type?, description?, status?, assignee?, priority?, dueDate? } */
export const POST = botRoute(async (req, ctx) => {
  const b = await readJson(req);
  const project = await resolveProject(ctx.org._id, b.project);
  const task = await createTaskAs(ctx.actor, {
    title: String(b.title ?? ""),
    projectId: project._id.toHexString(),
    type: parseType(b.type) ?? "issue",
    statusId: await resolveStatus(ctx.org._id, b.status),
    assigneeId: (await resolveAssignee(ctx, b.assignee)) ?? null,
    priority: parsePriority(b.priority),
    description: toDescriptionHtml(b.description),
    dueDate: b.dueDate == null ? null : String(b.dueDate),
  });
  return Response.json({ task }, { status: 201 });
});
