// One-off (VEC-407): backfills sub-task parent links (TaskDoc.parentId) and TaskDoc.createdByBot on the database in
// .env.local and records the migration in `migrations`, exactly as ensureIndexes does on a fresh start. Needed because a
// running dev server caches its init on globalThis and never re-runs ensureIndexes. Idempotent.
// Usage: node scripts/migrate-task-parents.mjs [--dry-run]
import fs from "node:fs";
import { registerHooks } from "node:module";
import { MongoClient } from "mongodb";

// src/lib imports siblings without an extension (bundler resolution); let node find the .ts file.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.includes("/src/lib/")) {
      try {
        return next(`${specifier}.ts`, context);
      } catch {}
    }
    return next(specifier, context);
  },
});
const { backfillTaskParents, TASK_PARENT_MIGRATION } = await import("../src/lib/parent-link-migration.ts");

const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
);
const dryRun = process.argv.includes("--dry-run");
const client = await new MongoClient(env.MONGODB_URI ?? "mongodb://127.0.0.1:27017").connect();
try {
  const db = client.db(env.MONGODB_DB ?? "aimpoint");
  if (!dryRun) {
    await db.collection("tasks").createIndex({ orgId: 1, parentId: 1 });
    await db.collection("tasks").createIndex({ parentId: 1, archivedAt: 1 });
  }
  const done = db.collection("migrations");
  if (!dryRun && (await done.findOne({ _id: TASK_PARENT_MIGRATION }))) {
    console.log(`${TASK_PARENT_MIGRATION}: already applied, nothing to do`);
  } else {
    const report = await backfillTaskParents(db, { dryRun });
    if (!dryRun) await done.updateOne({ _id: TASK_PARENT_MIGRATION }, { $setOnInsert: { at: new Date() } }, { upsert: true });
    console.log(`${TASK_PARENT_MIGRATION}: ${dryRun ? "dry run" : "applied"}`, report);
  }
} finally {
  await client.close();
}
