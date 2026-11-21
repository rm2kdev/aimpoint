// One-off (VEC-321): renames the stored bot connection fields connection.vectorUrl -> connection.aimpointUrl and
// connection.vectorKeySealed -> connection.aimpointKeySealed on every bot, in the database in .env.local (or the
// MONGODB_URI / MONGODB_DB in the environment, which win). Idempotent: a bot that already has the new field keeps it
// (a leftover old copy is dropped), and a second run reports 0 changes. The app reads the old field as a fallback
// (src/lib/connection-fields.ts), so dispatch keeps working before and after this runs.
// VEC-319 also sets mcpServerName to "aimpoint" on bots that have none (set up before VEC-198) or still say "vector":
// the app no longer falls back to the old server name (src/lib/mcp-name.ts).
// Usage: node scripts/migrate-connection-fields.mjs [--dry-run]
import fs from "node:fs";
import { MongoClient } from "mongodb";
import { LEGACY_CONNECTION_FIELDS } from "../src/lib/connection-fields.ts";

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
  const bots = db.collection("bots");
  console.log(`database ${db.databaseName}${dryRun ? " (dry run)" : ""}`);
  for (const [from, to] of Object.entries(LEGACY_CONNECTION_FIELDS)) {
    const oldF = `connection.${from}`;
    const newF = `connection.${to}`;
    const rename = { [oldF]: { $exists: true }, [newF]: { $exists: false } };
    const stale = { [oldF]: { $exists: true }, [newF]: { $exists: true } };
    if (dryRun) {
      console.log(`${oldF} -> ${newF}: ${await bots.countDocuments(rename)} to rename, ${await bots.countDocuments(stale)} stale old copies`);
      continue;
    }
    const r = await bots.updateMany(rename, { $rename: { [oldF]: newF } });
    const s = await bots.updateMany(stale, { $unset: { [oldF]: "" } });
    console.log(`${oldF} -> ${newF}: renamed ${r.modifiedCount}, dropped ${s.modifiedCount} stale old copies`);
  }
  const unnamed = { $or: [{ mcpServerName: { $exists: false } }, { mcpServerName: null }, { mcpServerName: "vector" }] };
  if (dryRun) console.log(`mcpServerName -> aimpoint: ${await bots.countDocuments(unnamed)} to set`);
  else console.log(`mcpServerName -> aimpoint: set ${(await bots.updateMany(unnamed, { $set: { mcpServerName: "aimpoint" } })).modifiedCount}`);
  const left = await bots.countDocuments({ $or: Object.keys(LEGACY_CONNECTION_FIELDS).map((f) => ({ [`connection.${f}`]: { $exists: true } })) });
  console.log(`bots still holding an old field: ${left}`);
} finally {
  await client.close();
}
