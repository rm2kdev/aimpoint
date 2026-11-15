import "server-only";
import { MongoClient, ObjectId, type Db, type Collection } from "mongodb";
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
  BotMentionDoc,
  NotificationDoc,
  LoginChallengeDoc,
} from "./types";

const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";
const dbName = process.env.MONGODB_DB ?? "vector";

type Cache = { client?: MongoClient; promise?: Promise<MongoClient>; indexed?: Promise<void> };
const g = globalThis as unknown as { __vectorMongo?: Cache };
const cache: Cache = (g.__vectorMongo ??= {});

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
    botMentions: db.collection<BotMentionDoc>("botMentions"),
    notifications: db.collection<NotificationDoc>("notifications"),
    loginChallenges: db.collection<LoginChallengeDoc>("loginChallenges"),
  };
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
    db.collection("statuses").createIndex({ orgId: 1, order: 1 }),
    db.collection("tasks").createIndex({ projectId: 1, number: 1 }, { unique: true }),
    db.collection("tasks").createIndex({ orgId: 1, updatedAt: -1 }),
    db.collection("tasks").createIndex({ orgId: 1, assigneeId: 1 }),
    db.collection("tasks").createIndex({ orgId: 1, title: "text" }),
    db.collection("tasks").createIndex({ orgId: 1, dependsOn: 1 }),
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
    db.collection("botMentions").createIndex({ botId: 1, deliveredAt: 1, createdAt: 1 }),
    db.collection("botMentions").createIndex({ taskId: 1 }),
    db.collection("notifications").createIndex({ orgId: 1, userId: 1, createdAt: -1 }),
    db.collection("notifications").createIndex({ orgId: 1, userId: 1, readAt: 1 }),
    db.collection("notifications").createIndex({ taskId: 1 }),
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
    const statuses = db.collection<StatusDoc>("statuses");
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
}
