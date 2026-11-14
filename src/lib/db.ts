import "server-only";
import { MongoClient, type Db, type Collection } from "mongodb";
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
  };
}
export type Cols = Awaited<ReturnType<typeof cols>>;
export type { Collection };

async function ensureIndexes(db: Db) {
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("orgs").createIndex({ slug: 1 }, { unique: true }),
    db.collection("memberships").createIndex({ orgId: 1, userId: 1 }, { unique: true }),
    db.collection("memberships").createIndex({ userId: 1 }),
    db.collection("projects").createIndex({ orgId: 1, key: 1 }, { unique: true }),
    db.collection("statuses").createIndex({ orgId: 1, order: 1 }),
    db.collection("tasks").createIndex({ projectId: 1, number: 1 }, { unique: true }),
    db.collection("tasks").createIndex({ orgId: 1, updatedAt: -1 }),
    db.collection("tasks").createIndex({ orgId: 1, assigneeId: 1 }),
    db.collection("tasks").createIndex({ orgId: 1, title: "text" }),
    db.collection("comments").createIndex({ taskId: 1, createdAt: 1 }),
    db.collection("activity").createIndex({ taskId: 1, createdAt: 1 }),
    db.collection("invites").createIndex({ token: 1 }, { unique: true }),
    db.collection("invites").createIndex({ orgId: 1 }),
  ]);
}
