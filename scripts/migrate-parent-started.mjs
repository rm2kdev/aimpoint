// One-off (VEC-420): moves parents already stuck in a not-started status while their sub-tasks are worked on to the
// status VEC-419's rule picks (src/lib/parent-started-migration.ts), in the database in .env.local (or the MONGODB_URI
// / MONGODB_DB in the environment, which win), and records it in `migrations` as ensureIndexes does on a fresh start.
// Needed because a running dev server caches its init on globalThis and never re-runs ensureIndexes. No wake-ups,
// notifications or realtime events; one status activity per moved parent. Idempotent: a second run moves nothing.
// Usage: node scripts/migrate-parent-started.mjs [--dry-run]
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
const { backfillParentStarted, PARENT_STARTED_MIGRATION } = await import("../src/lib/parent-started-migration.ts");

const file = new URL("../.env.local", import.meta.url);
const local = fs.existsSync(file)
  ? Object.fromEntries(
      fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]),
    )
  : {};
const env = { ...local, ...process.env };
const dryRun = process.argv.includes("--dry-run");
const client = await new MongoClient(env.MONGODB_URI ?? "mongodb://127.0.0.1:27017").connect();
try {
  const db = client.db(env.MONGODB_DB ?? "aimpoint");
  const done = db.collection("migrations");
  const applied = await done.findOne({ _id: PARENT_STARTED_MIGRATION });
  // Always run the plan (it is idempotent on its own), so a re-run shows it finds nothing left to move.
  const report = await backfillParentStarted(db, { dryRun });
  if (!dryRun) await done.updateOne({ _id: PARENT_STARTED_MIGRATION }, { $setOnInsert: { at: new Date() } }, { upsert: true });
  console.log(`${PARENT_STARTED_MIGRATION} on ${db.databaseName}: ${dryRun ? "dry run" : applied ? "re-run (was already recorded)" : "applied"}`);
  console.log(`found ${report.found}, moved ${report.moved}`);
  for (const k of report.keys) console.log(`  ${k}`);
} finally {
  await client.close();
}
