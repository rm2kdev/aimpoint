import "server-only";
import { MongoClient, ObjectId, type Db, type Collection } from "mongodb";
import { ranksAfter } from "./rank";
import { migrateProjectStatuses, PROJECT_STATUSES_MIGRATION } from "./project-statuses-migration";
import type {
  UserDoc,
  OrgDoc,
  MembershipDoc,
  ProjectDoc,
  StatusDoc,
  TaskDoc,
  CommentDoc,
  ActivityDoc,
  InviteDoc,
  BotDoc,
  BotRoleDoc,
  AgentClaimDoc,
  RunMarkDoc,
  BotMentionDoc,
  BotWakeDoc,
  NotificationDoc,
  LoginChallengeDoc,
  FlowDoc,
  ProjectFormDoc,
  FormUploadDoc,
} from "./types";
import { seedDefaultFlows, DEFAULT_FLOW_MIGRATION } from "./flows-migration";
import { backfillTaskParents, TASK_PARENT_MIGRATION } from "./parent-link-migration";
import { backfillParentStarted, PARENT_STARTED_MIGRATION } from "./parent-started-migration";

const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGODB_DB ?? "aimpoint";

type Cache = { client?: MongoClient; promise?: Promise<MongoClient>; indexed?: Promise<void> };
const g = globalThis as unknown as { __aimpointMongo?: Cache };
const cache: Cache = (g.__aimpointMongo ??= {});

async function client(): Promise<MongoClient> {
  if (cache.client) return cache.client;
  cache.promise ??= new MongoClient(uri, { maxPoolSize: 10 }).connect().then((c) => (cache.client = c));
  return cache.promise;
}

export async function getDb(): Promise<Db> {
  const db = (await client()).db(dbName);
  cache.indexed ??= ensureIndexes(db).catch((e) => {
    cache.indexed = undefined;
    throw e;
  });
  await cache.indexed;
  return db;
}

export async function cols() {
  const db = await getDb();
  return {
    users: db.collection<UserDoc>("users"),
    orgs: db.collection<OrgDoc>("orgs"),
    memberships: db.collection<MembershipDoc>("memberships"),
    projects: db.collection<ProjectDoc>("projects"),
    statuses: db.collection<StatusDoc>("statuses"),
    tasks: db.collection<TaskDoc>("tasks"),
    comments: db.collection<CommentDoc>("comments"),
    activity: db.collection<ActivityDoc>("activity"),
    invites: db.collection<InviteDoc>("invites"),
    bots: db.collection<BotDoc>("bots"),
    botRoles: db.collection<BotRoleDoc>("botRoles"),
    agentClaims: db.collection<AgentClaimDoc>("agentClaims"),
    runMarks: db.collection<RunMarkDoc>("runMarks"),
    botMentions: db.collection<BotMentionDoc>("botMentions"),
    botWakes: db.collection<BotWakeDoc>("botWakes"),
    notifications: db.collection<NotificationDoc>("notifications"),
    loginChallenges: db.collection<LoginChallengeDoc>("loginChallenges"),
    deletedUsers: db.collection<DeletedUserDoc>("deletedUsers"),
    flows: db.collection<FlowDoc>("flows"),
    projectForms: db.collection<ProjectFormDoc>("projectForms"),
    formUploads: db.collection<FormUploadDoc>("formUploads"),
  };
}
/**
 * What's left of a deleted account (VEC-48): only its id and the organisations where it left tasks,
 * comments or activity, so those render as "Deleted user" rather than "Former member". No name or email.
 */
export interface DeletedUserDoc {
  _id: ObjectId;
  orgIds: ObjectId[];
  deletedAt: Date;
}

export type Cols = Awaited<ReturnType<typeof cols>>;
export type { Collection };

async function ensureIndexes(db: Db) {
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("loginChallenges").createIndex({ tokenHash: 1 }, { unique: true }),
    db.collection("loginChallenges").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("orgs").createIndex({ slug: 1 }, { unique: true }),
    db.collection("memberships").createIndex({ orgId: 1, userId: 1 }, { unique: true }),
    db.collection("memberships").createIndex({ userId: 1 }),
    db.collection("projects").createIndex({ orgId: 1, key: 1 }, { unique: true }),
    // Statuses belong to a project (VEC-114): one ordered list per project.
    db.collection("statuses").createIndex({ orgId: 1, projectId: 1, order: 1 }),
    db.collection("tasks").createIndex({ projectId: 1, number: 1 }, { unique: true }),
    db.collection("tasks").createIndex({ orgId: 1, updatedAt: -1 }),
    db.collection("tasks").createIndex({ orgId: 1, assigneeId: 1 }),
    db.collection("tasks").createIndex({ orgId: 1, title: "text" }),
    db.collection("tasks").createIndex({ orgId: 1, dependsOn: 1 }),
    db.collection("tasks").createIndex({ orgId: 1, rank: 1 }),
    // Sub-task links (VEC-407): a parent's children, and the top_level filter.
    db.collection("tasks").createIndex({ orgId: 1, parentId: 1 }),
    db.collection("tasks").createIndex({ parentId: 1, archivedAt: 1 }),
    db.collection("comments").createIndex({ taskId: 1, createdAt: 1 }),
    db.collection("activity").createIndex({ taskId: 1, createdAt: 1 }),
    db.collection("invites").createIndex({ token: 1 }, { unique: true }),
    db.collection("invites").createIndex({ orgId: 1 }),
    db.collection("bots").createIndex({ keyHash: 1 }, { unique: true }),
    db.collection("bots").createIndex({ orgId: 1 }),
    db.collection("botRoles").createIndex({ orgId: 1, name: 1 }, { unique: true }),
    db.collection("agentClaims").createIndex({ botId: 1, taskId: 1 }, { unique: true }),
    db.collection("agentClaims").createIndex({ taskId: 1 }),
    // One bot triages a task at a time: the claim is the lock.
    db.collection("agentClaims").createIndex({ taskId: 1, kind: 1 }, { unique: true, partialFilterExpression: { kind: "triage" }, name: "one_triage_claim_per_task" }),
    // VEC-380 run marks: one per bot and task, read by task, swept by expiry; Mongo drops any a day past expiry.
    db.collection("runMarks").createIndex({ botId: 1, taskId: 1 }, { unique: true }),
    db.collection("runMarks").createIndex({ taskId: 1, expiresAt: 1 }),
    db.collection("runMarks").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 86_400 }),
    db.collection("botMentions").createIndex({ botId: 1, deliveredAt: 1, createdAt: 1 }),
    db.collection("botMentions").createIndex({ taskId: 1 }),
    // Queued push wake-ups (lib/wake-queue.ts): one per hand-off, due ones found by nextAttemptAt.
    db.collection("botWakes").createIndex({ botId: 1, taskId: 1, kind: 1 }, { unique: true }),
    db.collection("botWakes").createIndex({ failedAt: 1, nextAttemptAt: 1 }),
    db.collection("botWakes").createIndex({ taskId: 1 }),
    // VEC-263 (was VEC-225): Triage tasks held while their org is locked; the wake sweep looks them up every 15 s.
    db.collection("tasks").createIndex({ "triageHeld.at": 1 }, { partialFilterExpression: { "triageHeld.at": { $exists: true } } }),
    db.collection("botWakes").createIndex({ botId: 1, heldAt: 1 }),
    db.collection("notifications").createIndex({ orgId: 1, userId: 1, createdAt: -1 }),
    db.collection("notifications").createIndex({ orgId: 1, userId: 1, readAt: 1 }),
    db.collection("notifications").createIndex({ taskId: 1 }),
    db.collection("deletedUsers").createIndex({ orgIds: 1 }),
    // Analytics (VEC-132, lib/analytics.ts): org-wide time-range scans.
    db.collection("tasks").createIndex({ orgId: 1, createdAt: 1 }),
    db.collection("activity").createIndex({ orgId: 1, kind: 1, createdAt: 1 }),
    db.collection("comments").createIndex({ orgId: 1, createdAt: 1 }),
    db.collection("agentClaims").createIndex({ orgId: 1, claimedAt: 1 }),
    db.collection("agentClaims").createIndex({ orgId: 1, finishedAt: 1 }),
    db.collection("botMentions").createIndex({ orgId: 1, createdAt: 1 }),
    // Project flows (VEC-174): one org default (projectId null) and at most one override per project.
    db.collection("flows").createIndex({ orgId: 1, projectId: 1 }, { unique: true }),
    db.collection("tasks").createIndex({ orgId: 1, "flow.stepId": 1 }),
    // External forms (VEC-205): many per project; the public id resolves a submission.
    db.collection("projectForms").createIndex({ publicId: 1 }, { unique: true }),
    // Public projects (VEC-255): a signed-in account's own submissions to a project.
    db.collection("tasks").createIndex({ "source.userId": 1, projectId: 1, createdAt: -1 }, { partialFilterExpression: { "source.kind": "public" }, name: "public_submissions" }),
    db.collection("projectForms").createIndex({ orgId: 1, projectId: 1, createdAt: 1 }),
    db.collection("projectForms").createIndex({ orgId: 1, destinationStatusId: 1 }),
    // Public form image uploads (VEC-233): looked up by URL on submit, swept when unclaimed, TTL backstop on expiresAt.
    db.collection("formUploads").createIndex({ url: 1 }, { unique: true }),
    db.collection("formUploads").createIndex({ claimedTaskId: 1, createdAt: 1 }),
    db.collection("formUploads").createIndex({ orgId: 1 }),
    db.collection("formUploads").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Stripe billing (VEC-223): webhook lookups by customer/subscription; processed event ids kept 30 days.
    db.collection("orgs").createIndex({ "billing.stripeCustomerId": 1 }, { sparse: true }),
    db.collection("orgs").createIndex({ "billing.subscriptionId": 1 }, { sparse: true }),
    db.collection("stripeEvents").createIndex({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 }),
  ]);
  await migrate(db);
}

/**
 * One-off data migrations, each recorded in `migrations` so it runs once per database
 * (an admin who later deletes what a migration added keeps it deleted).
 */
async function migrate(db: Db) {
  const done = db.collection<{ _id: string; at: Date }>("migrations");
  const once = async (id: string, run: () => Promise<void>) => {
    if (await done.findOne({ _id: id })) return;
    await run();
    await done.updateOne({ _id: id }, { $setOnInsert: { at: new Date() } }, { upsert: true });
  };

  // Organisations created before the Triage stage existed get a Triage status right after their backlog.
  await once("2026-11-triage-status", async () => {
    // Ran while statuses were org-level (before VEC-114), so its docs have no projectId.
    const statuses = db.collection<Omit<StatusDoc, "projectId">>("statuses");
    for (const orgId of await statuses.distinct("orgId")) {
      if (await statuses.findOne({ orgId, category: "triage" })) continue;
      const list = await statuses.find({ orgId }).sort({ order: 1 }).toArray();
      const lastBacklog = list.findLastIndex((s) => s.category === "backlog");
      const at = lastBacklog + 1;
      // Renumber 0..n with the new status at `at` (orders can have gaps after deletes).
      const ops = list.map((s, i) => ({ updateOne: { filter: { _id: s._id }, update: { $set: { order: i < at ? i : i + 1 } } } }));
      if (ops.length) await statuses.bulkWrite(ops);
      await statuses.insertOne({ _id: new ObjectId(), orgId, name: "Triage", color: "#d6409f", category: "triage", order: at });
    }
  });

  // Manual task order (VEC-57): every task gets a rank, one key space per organisation, in the order the
  // lists showed before: by status (workflow order), then priority (high first), then newest first.
  await once("2026-11-task-rank", async () => {
    const tasks = db.collection<TaskDoc>("tasks");
    const statuses = db.collection<StatusDoc>("statuses");
    for (const orgId of await tasks.distinct("orgId")) {
      const order = new Map((await statuses.find({ orgId }).toArray()).map((s) => [s._id.toHexString(), s.order]));
      const list = await tasks.find({ orgId }, { projection: { statusId: 1, priority: 1, createdAt: 1, number: 1 } }).toArray();
      list.sort(
        (a, b) =>
          (order.get(a.statusId.toHexString()) ?? 1e9) - (order.get(b.statusId.toHexString()) ?? 1e9) ||
          b.priority - a.priority ||
          b.createdAt.getTime() - a.createdAt.getTime() ||
          b.number - a.number,
      );
      const ranks = ranksAfter(null, list.length);
      const ops = list.map((t, i) => ({ updateOne: { filter: { _id: t._id }, update: { $set: { rank: ranks[i] } } } }));
      if (ops.length) await tasks.bulkWrite(ops);
    }
  });

  // Per-project statuses (VEC-114): every project gets its own copy of the org's statuses, tasks (and their
  // status activity) point at their project's copy, and the org-level statuses go away.
  await once(PROJECT_STATUSES_MIGRATION, async () => {
    const report = await migrateProjectStatuses(db);
    console.log("[migrate] project statuses", report);
  });

  // Project flows (VEC-174): every existing org gets the behaviour-preserving default flow. Projects inherit
  // it (no project data changes); tasks are positioned lazily by the flow engine.
  await once(DEFAULT_FLOW_MIGRATION, async () => {
    const inserted = await seedDefaultFlows(db);
    console.log("[migrate] default flows", { inserted });
  });

  // Sub-task links (VEC-407): bot-created tasks an umbrella its creator triaged depends on get that umbrella as parent,
  // and bot-created tasks get createdByBot. Live DBs whose dev server already ran init: scripts/migrate-task-parents.mjs.
  await once(TASK_PARENT_MIGRATION, async () => {
    console.log("[migrate] task parents", await backfillTaskParents(db));
  });

  // Parents stuck in a not-started status while sub-tasks are worked on (VEC-420, rule VEC-419) move to the status the
  // live hook would pick. Live DBs whose dev server already ran init: scripts/migrate-parent-started.mjs.
  await once(PARENT_STARTED_MIGRATION, async () => {
    const { found, moved } = await backfillParentStarted(db);
    console.log("[migrate] parents started", { found, moved });
  });
}
