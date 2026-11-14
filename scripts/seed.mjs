// Seeds a demo organisation for local development.
// Usage: pnpm seed   (reads MONGODB_URI / MONGODB_DB from .env.local)
// Safe to re-run: it removes and recreates only the "northwind" demo org and its demo users.
import { readFileSync, existsSync } from "node:fs";
import { MongoClient, ObjectId } from "mongodb";
import bcrypt from "bcryptjs";

if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const client = await new MongoClient(process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017").connect();
const db = client.db(process.env.MONGODB_DB ?? "vector");
const PASSWORD = "vector-demo";

const people = [
  { name: "Ryan Lamvohee", email: "ryan@demo.vector.dev", role: "admin" },
  { name: "Mia Kowalski", email: "mia@demo.vector.dev", role: "member" },
  { name: "Sofia Ortega", email: "sofia@demo.vector.dev", role: "member" },
  { name: "Jonah Tan", email: "jonah@demo.vector.dev", role: "admin" },
];

const old = await db.collection("orgs").findOne({ slug: "northwind" });
if (old) {
  for (const c of ["memberships", "projects", "statuses", "tasks", "comments", "activity", "invites"]) {
    await db.collection(c).deleteMany({ orgId: old._id });
  }
  await db.collection("orgs").deleteOne({ _id: old._id });
}
await db.collection("users").deleteMany({ email: { $in: people.map((p) => p.email) } });

const now = Date.now();
const hash = await bcrypt.hash(PASSWORD, 10);
const users = people.map((p) => ({ _id: new ObjectId(), email: p.email, name: p.name, passwordHash: hash, createdAt: new Date(now - 30 * 864e5) }));
await db.collection("users").insertMany(users);
const [ryan, mia, sofia, jonah] = users;

const orgId = new ObjectId();
await db.collection("orgs").insertOne({ _id: orgId, name: "Northwind Labs", slug: "northwind", createdAt: new Date(now - 30 * 864e5) });
await db.collection("memberships").insertMany(
  users.map((u, i) => ({ _id: new ObjectId(), orgId, userId: u._id, role: people[i].role, createdAt: new Date(now - 30 * 864e5 + i * 1000) })),
);

const st = [
  ["Backlog", "#a3a3a3", "backlog"],
  ["Todo", "#737373", "unstarted"],
  ["In Progress", "#e5a00d", "started"],
  ["In Review", "#8b5cf6", "started"],
  ["Done", "#2f6fed", "done"],
  ["Cancelled", "#a3a3a3", "cancelled"],
].map(([name, color, category], order) => ({ _id: new ObjectId(), orgId, name, color, category, order }));
await db.collection("statuses").insertMany(st);
const S = Object.fromEntries(st.map((s) => [s.name, s._id]));

const projects = [
  { name: "Web App", key: "WEB", color: "#2f6fed" },
  { name: "API", key: "API", color: "#30a46c" },
  { name: "Mobile", key: "MOB", color: "#8b5cf6" },
].map((p, i) => ({ _id: new ObjectId(), orgId, ...p, nextNumber: 1, createdAt: new Date(now - 29 * 864e5 + i) }));

const tasks = [
  ["WEB", "Image paste in editor uploads twice on Safari", "issue", "In Progress", ryan, 3, "<p>Pasting a screenshot into the description on Safari 18 fires both <code>paste</code> and <code>drop</code>, so the image is uploaded twice and two copies appear.</p><p>Expected: one upload, one image node. Chrome and Firefox behave correctly.</p>"],
  ["WEB", "Org invite links expire after 7 days", "issue", "In Progress", sofia, 2, "<p>Invites should last 14 days to match the copy on the invite screen.</p>"],
  ["WEB", "Keyboard shortcut sheet (press ?)", "feature", "In Progress", ryan, 1, "<p>A single sheet listing every shortcut, opened with <code>?</code>.</p>"],
  ["WEB", "Dark mode contrast on muted labels", "issue", "In Review", ryan, 2, "<p>Secondary labels in dark mode measure 3.9:1 against the sidebar. Needs 4.5:1.</p>"],
  ["API", "Custom statuses per organisation", "feature", "In Review", jonah, 3, "<p>Admins can add, rename, reorder and remove statuses. Each status has a stage.</p>"],
  ["WEB", "Assignee picker should search by email", "feature", "Todo", ryan, 1, ""],
  ["WEB", "Comments lose formatting when edited", "issue", "Todo", mia, 2, ""],
  ["API", "Export tasks as CSV", "feature", "Todo", ryan, 1, "<p>Per project, respecting the current filters.</p>"],
  ["API", "Rate-limit image uploads per user", "issue", "Todo", jonah, 2, ""],
  ["MOB", "Push notification when assigned", "feature", "Backlog", null, 0, ""],
  ["MOB", "Offline queue for task edits", "feature", "Backlog", null, 1, ""],
  ["WEB", "Switch organisations from the sidebar", "feature", "Done", ryan, 2, ""],
  ["API", "Pusher private channel auth", "feature", "Done", jonah, 2, ""],
  ["MOB", "Login screen ignores system font size", "issue", "Todo", sofia, 2, ""],
];
const byKey = Object.fromEntries(projects.map((p) => [p.key, p]));
const docs = tasks.map(([pk, title, type, status, who, priority, description], i) => {
  const p = byKey[pk];
  const t = new Date(now - (tasks.length - i) * 3.6e6 * 7);
  return {
    _id: new ObjectId(),
    orgId,
    projectId: p._id,
    number: p.nextNumber++,
    title,
    description,
    type,
    statusId: S[status],
    assigneeId: who?._id ?? null,
    priority,
    createdBy: [ryan, mia, sofia, jonah][i % 4]._id,
    createdAt: t,
    updatedAt: t,
  };
});
await db.collection("projects").insertMany(projects);
await db.collection("tasks").insertMany(docs);
await db.collection("activity").insertMany(
  docs.map((d) => ({ _id: new ObjectId(), orgId, taskId: d._id, actorId: d.createdBy, kind: "created", createdAt: d.createdAt })),
);
const first = docs[0];
await db.collection("activity").insertOne({
  _id: new ObjectId(), orgId, taskId: first._id, actorId: mia._id, kind: "status",
  from: S["Todo"].toHexString(), to: S["In Progress"].toHexString(), createdAt: new Date(now - 2 * 3.6e6),
});
await db.collection("comments").insertOne({
  _id: new ObjectId(), orgId, taskId: first._id, authorId: jonah._id,
  body: "Reproduced on iPad too. Probably need to dedupe by file hash before upload.", createdAt: new Date(now - 40 * 6e4),
});

console.log(`Seeded Northwind Labs (/northwind). Sign in as ${people.map((p) => p.email).join(", ")} with password "${PASSWORD}".`);
await client.close();
