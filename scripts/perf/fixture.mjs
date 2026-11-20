// Throwaway "large" organisation for scripts/perf/drag.mjs: ~300 tasks over ~20 projects, the given user
// as its admin. Everything is keyed by the new org's id, so teardown deletes it from every collection.
import { createHash, randomBytes } from "node:crypto";
import { MongoClient, ObjectId } from "mongodb";
import { ranksAfter } from "../../src/lib/rank.ts";

const STATUSES = [
  ["Backlog", "#a3a3a3", "backlog", 60],
  ["Triage", "#d6409f", "triage", 0],
  ["Todo", "#737373", "unstarted", 100],
  ["In Progress", "#e5a00d", "started", 50],
  ["In Review", "#8b5cf6", "started", 30],
  ["Done", "#2f6fed", "done", 40],
  ["Cancelled", "#a3a3a3", "cancelled", 20],
];
const COLORS = ["#2f6fed", "#30a46c", "#8b5cf6", "#e5a00d", "#d6409f", "#0ea5e9", "#ef4444", "#14b8a6"];
const WORDS = ["Sync", "editor", "uploads", "billing", "webhook", "retry", "sidebar", "filters", "export", "search", "invite", "avatar", "timeline", "settings", "toast", "keyboard", "realtime", "cache", "import", "audit"];

export async function connect(env) {
  const client = await new MongoClient(env.MONGODB_URI ?? "mongodb://127.0.0.1:27017").connect();
  return { client, db: client.db(env.MONGODB_DB ?? "aimpoint") };
}

/**
 * Creates the org; returns { orgId, slug, projectKeys, taskCount, botKey, botTaskKeys }. A role-less fixture bot
 * (no connection, so nothing is pushed to it) creates every 10th task, so the runner can edit those over the REST
 * API mid-drag and the open list receives real `task.upsert` events.
 */
export async function createLargeOrg(db, userId, { tasks = 300, projects = 20 } = {}) {
  const now = Date.now();
  const orgId = new ObjectId();
  const slug = `perf-drag-${orgId.toHexString().slice(-6)}`;
  const uid = new ObjectId(userId);
  await db.collection("orgs").insertOne({ _id: orgId, name: "Perf drag (throwaway)", slug, createdAt: new Date(now) });
  await db.collection("memberships").insertOne({ _id: new ObjectId(), orgId, userId: uid, role: "admin", createdAt: new Date(now) });
  const ps = Array.from({ length: projects }, (_, i) => ({
    _id: new ObjectId(),
    orgId,
    name: `Project ${String.fromCharCode(65 + (i % 26))}${i >= 26 ? i : ""} ${WORDS[i % WORDS.length]}`,
    key: `P${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
    color: COLORS[i % COLORS.length],
    nextNumber: 1,
    createdAt: new Date(now - (projects - i) * 1000),
  }));
  await db.collection("projects").insertMany(ps);
  // Statuses belong to a project (VEC-114): every project gets the set; `st` stays the per-stage template.
  const st = STATUSES.map(([name, color, category], order) => ({ name, color, category, order }));
  const own = ps.map((p) => st.map((s) => ({ _id: new ObjectId(), orgId, projectId: p._id, ...s })));
  await db.collection("statuses").insertMany(own.flat());
  const botKey = `vec_${randomBytes(32).toString("base64url")}`;
  const botId = new ObjectId();
  await db.collection("bots").insertOne({
    _id: botId, orgId, name: "Perf Teammate Bot", description: "Fixture for scripts/perf/drag.mjs",
    avatar: { kind: "shape", shape: "ghost", color: "#8b5cf6" },
    keyHash: createHash("sha256").update(botKey).digest("hex"), keyHint: `vec_…${botKey.slice(-4)}`,
    keyRotatedAt: new Date(now), createdBy: uid, createdAt: new Date(now),
  });
  // Status mix scaled to the requested total (default 300: 240 in open statuses, 60 folded done/cancelled).
  const weights = STATUSES.map((s) => s[3]);
  const sum = weights.reduce((a, b) => a + b, 0);
  const perStatus = weights.map((w) => Math.round((w / sum) * tasks));
  const docs = [];
  let n = 0;
  st.forEach((s, si) => {
    for (let j = 0; j < perStatus[si]; j++, n++) {
      const pi = n % ps.length;
      const p = ps[pi];
      const t = new Date(now - (tasks - n) * 6e4);
      docs.push({
        _id: new ObjectId(),
        orgId,
        projectId: p._id,
        number: p.nextNumber++,
        title: `${WORDS[n % WORDS.length]} ${WORDS[(n * 7) % WORDS.length]} ${WORDS[(n * 13) % WORDS.length]} #${n + 1}`,
        description: "",
        type: ["issue", "feature", "task"][n % 3],
        statusId: own[pi][si]._id,
        assigneeId: n % 3 === 0 ? null : uid,
        priority: n % 4,
        dueDate: n % 9 === 0 ? new Date(now + (n % 20) * 864e5) : null,
        archivedAt: null,
        dependsOn: [],
        waitingOn: [],
        createdBy: n % 10 === 5 ? botId : uid,
        createdAt: t,
        updatedAt: t,
      });
    }
  });
  ranksAfter(null, docs.length).forEach((rank, i) => (docs[i].rank = rank));
  await db.collection("tasks").insertMany(docs);
  for (const p of ps) await db.collection("projects").updateOne({ _id: p._id }, { $set: { nextNumber: p.nextNumber } });
  const open = new Set(own.flat().filter((s) => s.category !== "done" && s.category !== "cancelled").map((s) => s._id.toHexString()));
  const keyOf = (d) => `${ps.find((p) => p._id.equals(d.projectId)).key}-${d.number}`;
  const botTaskKeys = docs.filter((d) => d.createdBy.equals(botId) && open.has(d.statusId.toHexString())).map(keyOf);
  return { orgId: orgId.toHexString(), slug, projectKeys: ps.map((p) => p.key), taskCount: docs.length, botKey, botTaskKeys };
}

/** Deletes the org and every document carrying its id; returns the per-collection counts. */
export async function deleteOrg(db, orgId) {
  const id = new ObjectId(orgId);
  const counts = {};
  for (const { name } of await db.listCollections().toArray()) {
    const r = await db.collection(name).deleteMany({ orgId: id });
    if (r.deletedCount) counts[name] = r.deletedCount;
  }
  const r = await db.collection("orgs").deleteOne({ _id: id });
  if (r.deletedCount) counts.orgs = r.deletedCount;
  return counts;
}

/** Any document still pointing at the org (should be 0 after deleteOrg). */
export async function leftovers(db, orgId) {
  const id = new ObjectId(orgId);
  let n = await db.collection("orgs").countDocuments({ _id: id });
  for (const { name } of await db.listCollections().toArray()) n += await db.collection(name).countDocuments({ orgId: id });
  return n;
}
