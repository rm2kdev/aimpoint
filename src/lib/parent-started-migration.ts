// VEC-420 backfill for VEC-419: parents that were already stuck in a not-started status while their sub-tasks were
// being worked on (Ryan's VEC-418 example: 3 sub-tasks Done, 2 In Progress, 2 Todo, parent still Todo) move to the
// status VEC-419's hook would have picked. No "server-only" and no path aliases (like parent-link-migration.ts), so
// scripts/migrate-parent-started.mjs can run it against a live database whose dev server already ran its init.
//
// Same rules as the live hook (lib/parent-progress.ts startParentOnActivity), no second copy: parentProgress and
// parentTarget (parent-progress-core.ts) decide whether and where, and the flow's say comes from waitStepAt /
// pickupDecision (flow-engine-core.ts, the pure halves of atWaitStep / pickupTarget). The write is the hook's: a
// conditional status update plus one status activity ("moved it from Todo to In Progress (sub-task VEC-12 started)"),
// with no flow re-plan, no reassign, no wake-up and no notification. Nothing is published either: open pages show it
// on their next load.
import { ObjectId, type Db } from "mongodb";
import { parentProgress, parentTarget, type ParentProgressReason, type Stage } from "./parent-progress-core";
import { locateStep, pickupDecision, waitStepAt, type FlowPosition } from "./flow-engine-core";
import { resolveFlowSteps, type FlowDirectory, type FlowStatusLike, type ResolvedFlow } from "./flow-model";
import { flowStepsFromDoc } from "./flow-convert";
import { defaultFlowDoc } from "./flows-migration";
import type { ActivityDoc, FlowDoc, ProjectDoc, StatusDoc, TaskDoc } from "./types";

export const PARENT_STARTED_MIGRATION = "2026-11-parent-started";

const hex = (id: ObjectId) => id.toHexString();
const toLike = (s: StatusDoc): FlowStatusLike => ({ id: hex(s._id), name: s.name, category: s.category, order: s.order });

type Sub = Pick<TaskDoc, "_id" | "orgId" | "projectId" | "number" | "statusId" | "parentId" | "createdBy" | "assigneeId" | "updatedAt">;
type Parent = Pick<TaskDoc, "_id" | "orgId" | "projectId" | "number" | "statusId" | "flow" | "archivedAt" | "stopped">;

export interface ParentStartedMove {
  parentId: ObjectId;
  orgId: ObjectId;
  /** e.g. "VEC-418". */
  key: string;
  from: { id: ObjectId; name: string };
  to: { id: ObjectId; name: string };
  reason: ParentProgressReason;
  /** The sub-task the activity line names: the most recently changed started one, else the most recently done one. */
  subtask: { id: ObjectId; key: string };
  /** Who the activity is attributed to: whoever last moved that sub-task's status, else its assignee, else its creator. */
  actorId: ObjectId;
}

/**
 * What the backfill would do: every non-archived parent in a not-started (unstarted-stage) status with at least one
 * non-archived sub-task in a started or done stage, and the status VEC-419's rule moves it to. Read-only.
 */
export async function planParentStarted(db: Db): Promise<ParentStartedMove[]> {
  const tasks = db.collection<TaskDoc>("tasks");
  const subs = (await tasks
    .find(
      { parentId: { $type: "objectId" }, $or: [{ archivedAt: null }, { archivedAt: { $exists: false } }] },
      { projection: { orgId: 1, projectId: 1, number: 1, statusId: 1, parentId: 1, createdBy: 1, assigneeId: 1, updatedAt: 1 } },
    )
    .toArray()) as Sub[];
  if (!subs.length) return [];

  const parents = (await tasks
    .find({ _id: { $in: [...new Set(subs.map((s) => hex(s.parentId!)))].map((h) => new ObjectId(h)) } }, {
      projection: { orgId: 1, projectId: 1, number: 1, statusId: 1, flow: 1, archivedAt: 1, stopped: 1 },
    })
    .toArray()) as Parent[];
  const orgIds = [...new Set(parents.map((p) => hex(p.orgId)))].map((h) => new ObjectId(h));
  const [statusDocs, projects, flows, bots, memberships] = await Promise.all([
    db.collection<StatusDoc>("statuses").find({ orgId: { $in: orgIds } }).toArray(),
    db.collection<ProjectDoc>("projects").find({ orgId: { $in: orgIds } }, { projection: { key: 1, orgId: 1, flowMode: 1 } }).toArray(),
    db.collection<FlowDoc>("flows").find({ orgId: { $in: orgIds } }).toArray(),
    db.collection("bots").find({ orgId: { $in: orgIds } }, { projection: { name: 1, orgId: 1 } }).toArray(),
    db.collection("memberships").find({ orgId: { $in: orgIds } }, { projection: { userId: 1, orgId: 1 } }).toArray(),
  ]);
  const users = memberships.length
    ? await db.collection("users").find({ _id: { $in: memberships.map((m) => m.userId as ObjectId) } }, { projection: { name: 1 } }).toArray()
    : [];
  const userName = new Map(users.map((u) => [hex(u._id as ObjectId), u.name as string]));
  const statusById = new Map(statusDocs.map((s) => [hex(s._id), s]));
  const projectById = new Map(projects.map((p) => [hex(p._id), p]));

  // The flow of a project, as lib/flows resolveFlow resolves it (custom doc, else the org default, else the seeded default).
  const dirs = new Map<string, FlowDirectory>();
  const dirFor = (orgId: ObjectId): FlowDirectory => {
    const k = hex(orgId);
    let d = dirs.get(k);
    if (!d) {
      d = {
        bots: new Map(bots.filter((b) => (b.orgId as ObjectId).equals(orgId)).map((b) => [hex(b._id as ObjectId), b.name as string])),
        people: new Map(
          memberships.filter((m) => (m.orgId as ObjectId).equals(orgId)).map((m) => [hex(m.userId as ObjectId), userName.get(hex(m.userId as ObjectId)) ?? ""]),
        ),
      };
      dirs.set(k, d);
    }
    return d;
  };
  const flowCache = new Map<string, ResolvedFlow | null>();
  const flowFor = (project: ProjectDoc, statuses: FlowStatusLike[]): ResolvedFlow | null => {
    const k = hex(project._id);
    if (flowCache.has(k)) return flowCache.get(k)!;
    const mode = project.flowMode ?? "inherit";
    let flow: ResolvedFlow | null = null;
    if (mode !== "off") {
      const own = mode === "custom" ? flows.find((f) => f.projectId?.equals(project._id)) : undefined;
      const doc = own ?? flows.find((f) => f.orgId.equals(project.orgId) && f.projectId == null) ?? { ...defaultFlowDoc(project.orgId), version: 0 };
      flow = resolveFlowSteps(flowStepsFromDoc(doc.steps), statuses, dirFor(project.orgId), { source: own ? "project" : "org", version: doc.version });
    }
    flowCache.set(k, flow);
    return flow;
  };

  const subsByParent = new Map<string, Sub[]>();
  for (const s of subs) {
    const k = hex(s.parentId!);
    const list = subsByParent.get(k) ?? [];
    list.push(s);
    subsByParent.set(k, list);
  }
  const keyOf = (t: { projectId: ObjectId; number: number }) => `${projectById.get(hex(t.projectId))?.key ?? "?"}-${t.number}`;
  const stageOf = (statusId: ObjectId) => (statusById.get(hex(statusId))?.category ?? null) as Stage | null;
  const newest = (list: Sub[]) => [...list].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0];

  const moves: ParentStartedMove[] = [];
  for (const parent of parents) {
    const current = statusById.get(hex(parent.statusId));
    const project = projectById.get(hex(parent.projectId));
    if (!current || !project || !current.projectId.equals(parent.projectId)) continue;
    const mine = (subsByParent.get(hex(parent._id)) ?? []).filter((s) => s.orgId.equals(parent.orgId));
    const started = mine.filter((s) => stageOf(s.statusId) === "started");
    const done = mine.filter((s) => stageOf(s.statusId) === "done");
    // As if the sub-task that last did something had just entered its status (started wins: work is under way).
    const sub = started.length ? newest(started) : done.length ? newest(done) : null;
    if (!sub) continue;
    const reason = parentProgress({
      parentStage: current.category as Stage,
      subtaskTo: stageOf(sub.statusId),
      parentArchived: !!parent.archivedAt,
      parentStopped: !!parent.stopped,
    });
    if (!reason) continue;

    const statuses = statusDocs.filter((s) => s.projectId.equals(parent.projectId)).map(toLike);
    const flow = flowFor(project, statuses);
    const status = statuses.find((s) => s.id === hex(parent.statusId)) ?? null;
    const pos: FlowPosition | null =
      flow && flow.steps.length && status ? { flow, statuses, status, current: locateStep(flow, status, parent.flow?.stepId) } : null;
    if (waitStepAt(pos, parent.flow)) continue;
    const target = parentTarget(
      statuses.map((s) => ({ id: s.id, stage: s.category as Stage, order: s.order, name: s.name })),
      pickupDecision(pos, parent.flow),
    );
    if (!target || target.id === hex(current._id)) continue;

    const lastMove = await db
      .collection<ActivityDoc>("activity")
      .find({ taskId: sub._id, kind: "status" }, { projection: { actorId: 1 } })
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    moves.push({
      parentId: parent._id,
      orgId: parent.orgId,
      key: keyOf(parent),
      from: { id: current._id, name: current.name },
      to: { id: new ObjectId(target.id), name: target.name },
      reason,
      subtask: { id: sub._id, key: keyOf(sub) },
      actorId: lastMove?.actorId ?? sub.assigneeId ?? sub.createdBy,
    });
  }
  return moves.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

/**
 * Applies the plan (or, with dryRun, only reports it). Idempotent: each write is conditional on the status the plan
 * read, and a moved parent is no longer in a not-started status, so a second run finds nothing. One status activity
 * per moved parent; no wake-ups, notifications or realtime events.
 */
export async function backfillParentStarted(db: Db, opts: { dryRun?: boolean } = {}) {
  const moves = await planParentStarted(db);
  const keys = moves.map((m) => `${m.key} ${m.from.name} -> ${m.to.name} (${m.subtask.key} ${m.reason})`);
  if (opts.dryRun) return { found: moves.length, moved: 0, keys };
  const tasks = db.collection<TaskDoc>("tasks");
  const activity = db.collection<ActivityDoc>("activity");
  const moved: string[] = [];
  for (const m of moves) {
    const now = new Date();
    const r = await tasks.updateOne({ _id: m.parentId, orgId: m.orgId, statusId: m.from.id }, { $set: { statusId: m.to.id, updatedAt: now } });
    if (!r.modifiedCount) continue;
    await activity.insertOne({
      _id: new ObjectId(),
      orgId: m.orgId,
      taskId: m.parentId,
      actorId: m.actorId,
      kind: "status",
      from: hex(m.from.id),
      to: hex(m.to.id),
      note: m.reason === "done" ? "subtask_done" : "subtask_started",
      subtask: m.subtask.key,
      createdAt: now,
    });
    moved.push(m.key);
  }
  return { found: moves.length, moved: moved.length, keys };
}
