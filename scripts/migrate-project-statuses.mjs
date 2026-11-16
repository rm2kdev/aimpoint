// One-off (VEC-114): runs the per-project statuses migration on the database in .env.local and records it in
// `migrations`, exactly as ensureIndexes does on a fresh start. Needed because a running dev server caches its
// init on globalThis and never re-runs ensureIndexes. Idempotent: a second run reports "already applied".
// Usage: node scripts/migrate-project-statuses.mjs
import fs from "node:fs";
import { MongoClient } from "mongodb";
import { migrateProjectStatuses, PROJECT_STATUSES_MIGRATION } from "../src/lib/project-statuses-migration.ts";

const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
);
const client = await new MongoClient(env.MONGODB_URI ?? "mongodb://127.0.0.1:27017").connect();
try {
  const db = client.db(env.MONGODB_DB ?? "vector");
  await db.collection("statuses").createIndex({ orgId: 1, projectId: 1, order: 1 });
  const done = db.collection("migrations");
  if (await done.findOne({ _id: PROJECT_STATUSES_MIGRATION })) {
    console.log(`${PROJECT_STATUSES_MIGRATION}: already applied, nothing to do`);
  } else {
    const report = await migrateProjectStatuses(db);
    await done.updateOne({ _id: PROJECT_STATUSES_MIGRATION }, { $setOnInsert: { at: new Date() } }, { upsert: true });
    console.log(`${PROJECT_STATUSES_MIGRATION}: applied`, report);
  }
} finally {
  await client.close();
}
