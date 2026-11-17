import "server-only";
import { ObjectId, type Document } from "mongodb";
import { cols } from "@/lib/db";
import { requireOrg } from "@/lib/session";
import { UserError } from "@/lib/result";
import { requireFeatureById } from "@/lib/billing-limits";
import { toProject } from "@/lib/data";
import { loadDirectory, personName } from "@/lib/mcp/context";
import { bucketStarts, isTimeZone, nextBucketStart } from "@/lib/analytics-time";
import {
  DEFAULT_ANALYTICS_TZ,
  STATUS_STAGES,
  TASK_TYPES,
  isAnalyticsGranularity,
  isClosedCategory,
  type AnalyticsBacklog,
  type AnalyticsBreakdown,
  type AnalyticsContributor,
  type AnalyticsCount,
  type AnalyticsDuration,
  type AnalyticsDurationSeries,
  type AnalyticsGranularity,
  type AnalyticsProject,
  type AnalyticsQuery,
  type AnalyticsReport,
  type AnalyticsSplitCount,
  type Priority,
  type StatusCategory,
  type TaskType,
} from "@/lib/types";

/**
 * Analytics data layer (VEC-132). Every analytics report (screen, CSV, REST/MCP export) reads from
 * `loadAnalytics`, which is admin-only.
 *
 * Rules, applied the same way to every metric:
 * - Stages, never status names: "closed" = a status whose stage is done or cancelled (`isClosedCategory`),
 *   looked up per project (statuses are per project since VEC-114).
 * - Opened = task created in the period. Closed = a status change from an open stage into done/cancelled in the
 *   period (from the `status` activity; done -> cancelled is not a new close, a reopen and re-close counts twice).
 *   Reopened = closed -> open. Tasks whose closes predate status activity logging count as closed throughout.
 * - Archived tasks are left out everywhere: a task archived *now* is excluded from every metric, together with its
 *   comments, activity, claims and mentions (current state, not as of the period), so totals always agree with
 *   each other and with the task lists people see. Deleted tasks are gone with their history.
 * - A task counts in its *current* project for the project filter and per-project breakdowns.
 * - Contributor filter (VEC-135): every actor-attributed count keeps only that person's or bot's own rows (tasks they
 *   created, closes and reopens they made, their comments, activity and bot work; for a person, the bots they
 *   mentioned; for a bot, mentions of it). State that has no actor (backlog, open-task age, tasks right now) counts
 *   the tasks assigned to them now.
 * - A task created straight into a done/cancelled status (its first status activity starts there, or it has none)
 *   counts as opened and closed at creation, so backlog change = opened - closed + reopened. Those closes have no
 *   cycle time and are left out of the cycle-time figures.
 * - People vs bots: an actor is a bot when the org has a bot with that id, or when the id is no user at all (bots are
 *   hard-deleted, people never are: they leave a user doc or a `deletedUsers` tombstone). Everyone else (members,
 *   former members, deleted accounts) is a person. Names go through `personName`, so deleted accounts read
 *   "Deleted user"; deleted bots read "Deleted bot".
 * - Backlog / open-task age at a moment T are rebuilt from the task's current status and its open/closed
 *   crossings after T. Tasks-by-stage/priority/type `open` counts are a snapshot of now.
 * - Buckets are cut by `$dateTrunc` in the viewer's timezone (Monday-start weeks) and matched to the buckets
 *   from lib/analytics-time.ts, which also fills empty ones. Previous period = the equal-length span before `from`.
 */

const CONTRIBUTOR_LIMIT = 50;
const ACTIVITY_KINDS = ["status", "assignee", "dependency_added", "dependency_removed"] as const;

interface Period {
  from: Date;
  to: Date;
  prevFrom: Date;
  unit: AnalyticsGranularity;
  tz: string;
  projectId: ObjectId | null;
  contributorId: ObjectId | null;
  buckets: Date[];
  /** End of each bucket (the next bucket's start; `to` for the last one). */
  ends: Date[];
}

function toDate(v: string | Date, name: string): Date {
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new UserError(`"${name}" isn't a valid date-time.`);
  return d;
}

export function parseAnalyticsQuery(q: AnalyticsQuery): Period {
  const from = toDate(q.from, "from");
  const to = toDate(q.to, "to");
  if (!(from < to)) throw new UserError("The period must end after it starts.");
  if (!isAnalyticsGranularity(q.granularity)) throw new UserError(`Unknown granularity "${String(q.granularity)}": use hour, day, week or month.`);
  const tz = q.tz?.trim() || DEFAULT_ANALYTICS_TZ;
  if (!isTimeZone(tz)) throw new UserError(`Unknown timezone "${tz}".`);
  let projectId: ObjectId | null = null;
  if (q.projectId) {
    if (!ObjectId.isValid(q.projectId)) throw new UserError("Unknown project.");
    projectId = new ObjectId(q.projectId);
  }
  let contributorId: ObjectId | null = null;
  if (q.contributorId) {
    if (!ObjectId.isValid(q.contributorId)) throw new UserError("Unknown person or bot.");
    contributorId = new ObjectId(q.contributorId);
  }
  let buckets: Date[];
  try {
    buckets = bucketStarts(from, to, q.granularity, tz);
  } catch (e) {
    if (e instanceof RangeError) throw new UserError(e.message);
    throw e;
  }
  const ends = buckets.map((b, i) => (i + 1 < buckets.length ? buckets[i + 1] : new Date(Math.min(nextBucketStart(b, q.granularity, tz).getTime(), to.getTime()))));
  return { from, to, prevFrom: new Date(from.getTime() - (to.getTime() - from.getTime())), unit: q.granularity, tz, projectId, contributorId, buckets, ends };
}

/**
 * The analytics report for an organisation. Admins only: members (and anyone outside the org) get an AuthError,
 * which `guard()` turns into `{ok:false}`.
 */
export async function loadAnalytics(slug: string, query: AnalyticsQuery): Promise<AnalyticsReport> {
  const { org } = await requireOrg(slug, { admin: true });
  return computeAnalytics(org._id, query);
}

/* ---------------- accumulation helpers ---------------- */

class Count {
  total = 0;
  previous = 0;
  series: number[];
  constructor(private index: Map<number, number>) {
    this.series = new Array(index.size).fill(0);
  }
  add(cur: boolean, b: Date | null, n: number) {
    if (!cur) {
      this.previous += n;
      return;
    }
    this.total += n;
    const i = b ? this.index.get(b.getTime()) : undefined;
    if (i !== undefined) this.series[i] += n;
    else unbucketed.n += n;
  }
  out(): AnalyticsCount {
    return { total: this.total, previous: this.previous, series: this.series };
  }
}

/** Events that `$dateTrunc` put in a bucket the JS bucket list doesn't have (should stay 0; logged if not). */
const unbucketed = { n: 0 };

class Split {
  people: Count;
  bots: Count;
  all: Count;
  constructor(index: Map<number, number>) {
    this.people = new Count(index);
    this.bots = new Count(index);
    this.all = new Count(index);
  }
  add(cur: boolean, b: Date | null, n: number, bot: boolean) {
    this.all.add(cur, b, n);
    (bot ? this.bots : this.people).add(cur, b, n);
  }
  out(): AnalyticsSplitCount {
    return { ...this.all.out(), people: this.people.out(), bots: this.bots.out() };
  }
}

/** Exact percentile (linear interpolation between ranks) of an ascending list, rounded to ms. */
function percentile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo));
}

function duration(values: number[]): AnalyticsDuration {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, medianMs: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9) };
}

function durationSeries(cur: number[], prev: number[], perBucket: number[][]): AnalyticsDurationSeries {
  const stats = perBucket.map(duration);
  return { ...duration(cur), previous: duration(prev), series: stats.map((s) => s.medianMs), p90Series: stats.map((s) => s.p90Ms) };
}

class Breakdown {
  byStage = Object.fromEntries(STATUS_STAGES.map((s) => [s, 0])) as Record<StatusCategory, number>;
  pri = new Map<Priority, { open: number; opened: number; closed: number }>(([0, 1, 2, 3] as Priority[]).map((k) => [k, { open: 0, opened: 0, closed: 0 }]));
  type = new Map<TaskType, { open: number; opened: number; closed: number }>(TASK_TYPES.map((k) => [k, { open: 0, opened: 0, closed: 0 }]));
  bump(pr: Priority, ty: TaskType, field: "open" | "opened" | "closed", n: number) {
    const a = this.pri.get(pr);
    if (a) a[field] += n;
    const b = this.type.get(ty);
    if (b) b[field] += n;
  }
  out(): AnalyticsBreakdown {
    return {
      byStage: this.byStage,
      byPriority: [...this.pri].map(([key, v]) => ({ key, ...v })).reverse(),
      byType: [...this.type].map(([key, v]) => ({ key, ...v })),
    };
  }
}

/* ---------------- the report ---------------- */

interface OpenStateRow {
  p: ObjectId;
  c: Date;
  openNow: boolean;
  x: { at: Date; close: boolean }[];
}

/** Open at instant T: created before T and, after the crossings before T, not in a closed stage. */
function openAt(t: OpenStateRow, at: Date): boolean {
  if (t.c >= at) return false;
  const next = t.x.find((x) => x.at >= at);
  return next ? next.close : t.openNow;
}

/**
 * Builds the report for an organisation id with no authorisation check: callers must have authorised
 * (loadAnalytics does `requireOrg(slug, {admin: true})`). Exported for the export endpoints and scripts.
 */
export async function computeAnalytics(orgId: ObjectId, query: AnalyticsQuery): Promise<AnalyticsReport> {
  // Free plan has no Analytics (VEC-224): every caller (screen, refresh, CSV, REST, MCP) goes through here.
  await requireFeatureById(orgId, "analytics");
  const p = parseAnalyticsQuery(query);
  const c = await cols();
  const [statuses, dir, projectDocs] = await Promise.all([
    c.statuses.find({ orgId }, { projection: { _id: 1, category: 1 } }).toArray(),
    loadDirectory(orgId),
    c.projects.find({ orgId }).sort({ createdAt: 1 }).toArray(),
  ]);
  if (p.projectId && !projectDocs.some((d) => d._id.equals(p.projectId!))) throw new UserError("Unknown project.");
  // Contributor filter (VEC-135): a member, a bot of this org, or a former member who left a tombstone.
  const who = p.contributorId?.toHexString() ?? null;
  const contributorKind = who ? (dir.get(who)?.kind ?? (dir.deleted.has(who) ? "user" : null)) : null;
  if (who && !contributorKind) throw new UserError("Unknown person or bot.");
  const actor = p.contributorId;
  /** `{field: actor}` when the report is limited to one contributor. */
  const by = (field: string): Document => (actor ? { [field]: actor } : {});

  const stageOf = new Map(statuses.map((s) => [s._id.toHexString(), s.category]));
  const closed = statuses.filter((s) => isClosedCategory(s.category));
  const closedHex = closed.map((s) => s._id.toHexString());
  const closedIds = closed.map((s) => s._id);
  const doneHex = closed.filter((s) => s.category === "done").map((s) => s._id.toHexString());

  const range = (field: string) => ({ [field]: { $gte: p.prevFrom, $lt: p.to } });
  const cur = (field: string) => ({ $gte: [`$${field}`, p.from] });
  const bucket = (field: string) => {
    const trunc: Document = { date: `$${field}`, unit: p.unit, timezone: p.tz };
    if (p.unit === "week") trunc.startOfWeek = "monday";
    return { $cond: [cur(field), { $dateTrunc: trunc }, null] };
  };
  const projectMatch = p.projectId ? { projectId: p.projectId } : {};
  /** Joins the row's task: drops rows of deleted or archived tasks and applies the project filter. */
  const taskScope = (): Document[] => [
    { $lookup: { from: "tasks", localField: "taskId", foreignField: "_id", as: "t", pipeline: [{ $project: { projectId: 1, archivedAt: 1, createdAt: 1, priority: 1, type: 1 } }] } },
    { $unwind: "$t" },
    { $match: { "t.archivedAt": null, ...(p.projectId ? { "t.projectId": p.projectId } : {}) } },
  ];

  type Key = { cur: boolean; b: Date | null; p: ObjectId };
  type Close = { cur: boolean; b: Date | null; p: ObjectId; a: ObjectId; done: boolean; dur: number | null; pr: Priority; ty: TaskType };
  const [opened, createdClosed, [act], [com], [claims], mentionsOfBots, snapshot, openState] = await Promise.all([
    c.tasks
      .aggregate<{ _id: Key & { a: ObjectId; pr: Priority; ty: TaskType }; n: number }>([
        { $match: { orgId, archivedAt: null, ...projectMatch, ...by("createdBy"), ...range("createdAt") } },
        { $group: { _id: { cur: cur("createdAt"), b: bucket("createdAt"), p: "$projectId", a: "$createdBy", pr: "$priority", ty: "$type" }, n: { $sum: 1 } } },
      ])
      .toArray(),
    // Tasks created straight into a closed stage: their first status activity leaves one, or they have none and are closed.
    c.tasks
      .aggregate<Close>([
        { $match: { orgId, archivedAt: null, ...projectMatch, ...by("createdBy"), ...range("createdAt") } },
        { $lookup: { from: "activity", localField: "_id", foreignField: "taskId", as: "first", pipeline: [{ $match: { kind: "status" } }, { $sort: { createdAt: 1 } }, { $limit: 1 }, { $project: { _id: 0, from: 1 } }] } },
        { $addFields: { initial: { $ifNull: [{ $first: "$first.from" }, { $toString: "$statusId" }] } } },
        { $match: { $expr: { $in: ["$initial", closedHex] } } },
        { $project: { _id: 0, cur: cur("createdAt"), b: bucket("createdAt"), p: "$projectId", a: "$createdBy", done: { $in: ["$initial", doneHex] }, dur: null, pr: "$priority", ty: "$type" } },
      ])
      .toArray(),
    c.activity
      .aggregate<{
        series: { _id: Key & { a: ObjectId; k: (typeof ACTIVITY_KINDS)[number] }; n: number }[];
        closes: Close[];
        reopens: { _id: Key; n: number }[];
        actors: { _id: ObjectId; n: number }[];
      }>([
        { $match: { orgId, kind: { $in: [...ACTIVITY_KINDS] }, ...by("actorId"), ...range("createdAt") } },
        ...taskScope(),
        { $addFields: { cur: cur("createdAt"), b: bucket("createdAt"), fc: { $in: ["$from", closedHex] }, tc: { $in: ["$to", closedHex] } } },
        {
          $facet: {
            series: [{ $group: { _id: { cur: "$cur", b: "$b", p: "$t.projectId", a: "$actorId", k: "$kind" }, n: { $sum: 1 } } }],
            closes: [
              { $match: { kind: "status", fc: false, tc: true } },
              { $project: { _id: 0, cur: 1, b: 1, p: "$t.projectId", a: "$actorId", done: { $in: ["$to", doneHex] }, dur: { $subtract: ["$createdAt", "$t.createdAt"] }, pr: "$t.priority", ty: "$t.type" } },
            ],
            reopens: [{ $match: { kind: "status", fc: true, tc: false } }, { $group: { _id: { cur: "$cur", b: "$b", p: "$t.projectId" }, n: { $sum: 1 } } }],
            actors: [{ $match: { cur: true } }, { $group: { _id: "$actorId", n: { $sum: 1 } } }],
          },
        },
      ])
      .toArray(),
    c.comments
      .aggregate<{ series: { _id: Key & { a: ObjectId }; n: number; m: number }[]; actors: { _id: ObjectId; n: number; m: number }[] }>([
        { $match: { orgId, ...by("authorId"), ...range("createdAt") } },
        ...taskScope(),
        { $addFields: { cur: cur("createdAt"), b: bucket("createdAt"), m: { $size: { $ifNull: ["$mentions", []] } } } },
        {
          $facet: {
            series: [{ $group: { _id: { cur: "$cur", b: "$b", p: "$t.projectId", a: "$authorId" }, n: { $sum: 1 }, m: { $sum: "$m" } } }],
            actors: [{ $match: { cur: true } }, { $group: { _id: "$authorId", n: { $sum: 1 }, m: { $sum: "$m" } } }],
          },
        },
      ])
      .toArray(),
    c.agentClaims
      .aggregate<{ pickups: { _id: Key & { bot: ObjectId }; n: number }[]; completions: { _id: Key & { bot: ObjectId }; n: number }[] }>([
        { $match: { orgId, ...(actor ? { botId: actor } : {}), $or: [range("claimedAt"), range("finishedAt")] } },
        ...taskScope(),
        {
          $facet: {
            pickups: [{ $match: range("claimedAt") }, { $group: { _id: { cur: cur("claimedAt"), b: bucket("claimedAt"), p: "$t.projectId", bot: "$botId" }, n: { $sum: 1 } } }],
            completions: [{ $match: { state: "done", ...range("finishedAt") } }, { $group: { _id: { cur: cur("finishedAt"), b: bucket("finishedAt"), p: "$t.projectId", bot: "$botId" }, n: { $sum: 1 } } }],
          },
        },
      ])
      .toArray(),
    c.botMentions
      .aggregate<{ _id: Key; n: number }>([
        // A bot: mentions of it. A person: bots they mentioned (the mention's comment is theirs).
        { $match: { orgId, ...(actor && contributorKind === "bot" ? { botId: actor } : {}), ...range("createdAt") } },
        ...(actor && contributorKind !== "bot"
          ? [
              { $lookup: { from: "comments", localField: "commentId", foreignField: "_id", as: "cm", pipeline: [{ $project: { authorId: 1 } }] } },
              { $match: { "cm.authorId": actor } },
            ]
          : []),
        ...taskScope(),
        { $group: { _id: { cur: cur("createdAt"), b: bucket("createdAt"), p: "$t.projectId" }, n: { $sum: 1 } } },
      ])
      .toArray(),
    c.tasks
      .aggregate<{ _id: { p: ObjectId; s: ObjectId; pr: Priority; ty: TaskType }; n: number }>([
        { $match: { orgId, archivedAt: null, ...projectMatch, ...by("assigneeId") } },
        { $group: { _id: { p: "$projectId", s: "$statusId", pr: "$priority", ty: "$type" }, n: { $sum: 1 } } },
      ])
      .toArray(),
    // Tasks open at some moment of [prevFrom, to): open now, or crossed open/closed since prevFrom.
    c.tasks
      .aggregate<OpenStateRow>([
        { $match: { orgId, archivedAt: null, ...projectMatch, ...by("assigneeId"), createdAt: { $lt: p.to } } },
        { $addFields: { openNow: { $not: [{ $in: ["$statusId", closedIds] }] } } },
        {
          $lookup: {
            from: "activity",
            localField: "_id",
            foreignField: "taskId",
            as: "x",
            pipeline: [
              { $match: { kind: "status", createdAt: { $gte: p.prevFrom } } },
              { $addFields: { fc: { $in: ["$from", closedHex] }, tc: { $in: ["$to", closedHex] } } },
              { $match: { $expr: { $ne: ["$fc", "$tc"] } } },
              { $sort: { createdAt: 1 } },
              { $project: { _id: 0, at: "$createdAt", close: "$tc" } },
            ],
          },
        },
        { $match: { $or: [{ openNow: true }, { "x.0": { $exists: true } }] } },
        { $project: { _id: 0, p: "$projectId", c: "$createdAt", openNow: 1, x: 1 } },
      ])
      .toArray(),
  ]);

  /* ---- who is a bot: directory bots, plus ids that are no user at all (deleted bots) ---- */
  const unknown = new Set<string>();
  const see = (id: ObjectId) => {
    const hex = id.toHexString();
    if (!dir.has(hex) && !dir.deleted.has(hex)) unknown.add(hex);
  };
  for (const r of opened) see(r._id.a);
  for (const r of act?.series ?? []) see(r._id.a);
  for (const r of com?.series ?? []) see(r._id.a);
  const formerPeople = unknown.size
    ? new Set((await c.users.find({ _id: { $in: [...unknown].map((h) => new ObjectId(h)) } }, { projection: { _id: 1 } }).toArray()).map((u) => u._id.toHexString()))
    : new Set<string>();
  const isBotHex = (hex: string) => (dir.has(hex) ? dir.get(hex)!.kind === "bot" : !dir.deleted.has(hex) && !formerPeople.has(hex));
  const isBot = (id: ObjectId) => isBotHex(id.toHexString());
  const nameOf = (hex: string) => (!dir.has(hex) && isBotHex(hex) ? "Deleted bot" : personName(dir, hex));

  /* ---- fold the rows ---- */
  unbucketed.n = 0;
  const index = new Map(p.buckets.map((b, i) => [b.getTime(), i]));
  const nb = p.buckets.length;
  const split = () => new Split(index);
  const count = () => new Count(index);

  const projects = p.projectId ? projectDocs.filter((d) => d._id.equals(p.projectId!)) : projectDocs;
  interface ProjAcc {
    opened: Count;
    closed: Count;
    done: Count;
    cancelled: Count;
    comments: Count;
    interactions: Count;
    cycle: number[];
    breakdown: Breakdown;
  }
  const perProject = new Map<string, ProjAcc>(
    projects.map((d) => [
      d._id.toHexString(),
      { opened: count(), closed: count(), done: count(), cancelled: count(), comments: count(), interactions: count(), cycle: [], breakdown: new Breakdown() },
    ]),
  );
  const proj = (id: ObjectId) => perProject.get(id.toHexString());

  const t = { opened: split(), closed: split(), done: split(), cancelled: split(), reopened: count() };
  const i = {
    total: split(),
    statusChanges: split(),
    assignments: split(),
    mentions: split(),
    dependencyEdits: split(),
    botPickups: count(),
    botCompletions: count(),
    botsMentioned: count(),
  };
  const comments = split();
  const breakdown = new Breakdown();
  const cycleCur: number[] = [];
  const cyclePrev: number[] = [];
  const cycleBuckets: number[][] = Array.from({ length: nb }, () => []);

  type Contrib = Omit<AnalyticsContributor, "id" | "name" | "kind">;
  const contributors = new Map<string, Contrib>();
  const contributor = (id: ObjectId) => {
    const hex = id.toHexString();
    let row = contributors.get(hex);
    if (!row) contributors.set(hex, (row = { tasksClosed: 0, done: 0, cancelled: 0, comments: 0, interactions: 0 }));
    return row;
  };

  for (const { _id: k, n } of opened) {
    t.opened.add(k.cur, k.b, n, isBot(k.a));
    const pa = proj(k.p);
    pa?.opened.add(k.cur, k.b, n);
    if (k.cur) {
      breakdown.bump(k.pr, k.ty, "opened", n);
      pa?.breakdown.bump(k.pr, k.ty, "opened", n);
    }
  }

  for (const { _id: k, n } of act?.series ?? []) {
    const target = k.k === "status" ? i.statusChanges : k.k === "assignee" ? i.assignments : i.dependencyEdits;
    target.add(k.cur, k.b, n, isBot(k.a));
    i.total.add(k.cur, k.b, n, isBot(k.a));
    proj(k.p)?.interactions.add(k.cur, k.b, n);
  }
  for (const e of [...(act?.closes ?? []), ...createdClosed]) {
    const pa = proj(e.p);
    const bot = isBot(e.a);
    t.closed.add(e.cur, e.b, 1, bot);
    (e.done ? t.done : t.cancelled).add(e.cur, e.b, 1, bot);
    pa?.closed.add(e.cur, e.b, 1);
    (e.done ? pa?.done : pa?.cancelled)?.add(e.cur, e.b, 1);
    const dur = e.dur === null ? null : Math.max(0, e.dur);
    if (e.cur) {
      if (dur !== null) {
        cycleCur.push(dur);
        pa?.cycle.push(dur);
        const bi = e.b ? index.get(e.b.getTime()) : undefined;
        if (bi !== undefined) cycleBuckets[bi].push(dur);
      }
      breakdown.bump(e.pr, e.ty, "closed", 1);
      pa?.breakdown.bump(e.pr, e.ty, "closed", 1);
      const row = contributor(e.a);
      row.tasksClosed++;
      if (e.done) row.done++;
      else row.cancelled++;
    } else if (dur !== null) cyclePrev.push(dur);
  }
  for (const { _id: k, n } of act?.reopens ?? []) t.reopened.add(k.cur, k.b, n);
  for (const { _id, n } of act?.actors ?? []) contributor(_id).interactions += n;

  for (const { _id: k, n, m } of com?.series ?? []) {
    comments.add(k.cur, k.b, n, isBot(k.a));
    i.mentions.add(k.cur, k.b, m, isBot(k.a));
    i.total.add(k.cur, k.b, m, isBot(k.a));
    const pa = proj(k.p);
    pa?.comments.add(k.cur, k.b, n);
    pa?.interactions.add(k.cur, k.b, m);
  }
  for (const { _id, n, m } of com?.actors ?? []) {
    const row = contributor(_id);
    row.comments += n;
    row.interactions += m;
  }

  for (const [rows, target] of [
    [claims?.pickups ?? [], i.botPickups],
    [claims?.completions ?? [], i.botCompletions],
  ] as const) {
    for (const { _id: k, n } of rows) {
      target.add(k.cur, k.b, n);
      i.total.add(k.cur, k.b, n, true);
      proj(k.p)?.interactions.add(k.cur, k.b, n);
      if (k.cur) contributor(k.bot).interactions += n;
    }
  }
  for (const { _id: k, n } of mentionsOfBots) i.botsMentioned.add(k.cur, k.b, n);

  for (const { _id: k, n } of snapshot) {
    const stage = stageOf.get(k.s.toHexString());
    if (!stage) continue;
    const pa = proj(k.p);
    breakdown.byStage[stage] += n;
    if (pa) pa.breakdown.byStage[stage] += n;
    if (!isClosedCategory(stage)) {
      breakdown.bump(k.pr, k.ty, "open", n);
      pa?.breakdown.bump(k.pr, k.ty, "open", n);
    }
  }

  /* ---- backlog and open-task age at each moment ---- */
  const ageAt = (rows: OpenStateRow[], at: Date) => rows.filter((r) => openAt(r, at)).map((r) => at.getTime() - r.c.getTime());
  const backlogOf = (rows: OpenStateRow[]): AnalyticsBacklog => ({
    start: rows.filter((r) => openAt(r, p.from)).length,
    end: rows.filter((r) => openAt(r, p.to)).length,
    previousStart: rows.filter((r) => openAt(r, p.prevFrom)).length,
    series: p.ends.map((e) => rows.filter((r) => openAt(r, e)).length),
  });
  const agesAtEnds = p.ends.map((e) => ageAt(openState, e));
  const openAge: AnalyticsDurationSeries = {
    ...duration(ageAt(openState, p.to)),
    previous: duration(ageAt(openState, p.from)),
    series: agesAtEnds.map((a) => duration(a).medianMs),
    p90Series: agesAtEnds.map((a) => duration(a).p90Ms),
  };
  const openByProject = new Map<string, OpenStateRow[]>();
  for (const r of openState) {
    const key = r.p.toHexString();
    const list = openByProject.get(key);
    if (list) list.push(r);
    else openByProject.set(key, [r]);
  }

  if (unbucketed.n) console.warn(`[analytics] ${unbucketed.n} events fell outside the ${p.unit} buckets (${p.tz})`);

  const people: AnalyticsContributor[] = [];
  const bots: AnalyticsContributor[] = [];
  for (const [id, row] of contributors) {
    const kind = isBotHex(id) ? "bot" : "user";
    (kind === "bot" ? bots : people).push({ id, name: nameOf(id), kind, ...row });
  }
  const score = (r: AnalyticsContributor) => r.tasksClosed + r.comments + r.interactions;
  const rank = (list: AnalyticsContributor[]) => list.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name)).slice(0, CONTRIBUTOR_LIMIT);

  const projectReports: AnalyticsProject[] = projects.map((d) => {
    const pa = perProject.get(d._id.toHexString())!;
    const rows = openByProject.get(d._id.toHexString()) ?? [];
    return {
      project: toProject(d),
      opened: pa.opened.out(),
      closed: pa.closed.out(),
      done: pa.done.out(),
      cancelled: pa.cancelled.out(),
      comments: pa.comments.out(),
      interactions: pa.interactions.out(),
      backlog: backlogOf(rows),
      cycleTime: duration(pa.cycle),
      openAge: duration(ageAt(rows, p.to)),
      breakdown: pa.breakdown.out(),
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    period: {
      from: p.from.toISOString(),
      to: p.to.toISOString(),
      granularity: p.unit,
      tz: p.tz,
      projectId: p.projectId?.toHexString() ?? null,
      contributor: who && contributorKind ? { id: who, name: dir.has(who) ? dir.get(who)!.name : personName(dir, who), kind: contributorKind } : null,
    },
    previous: { from: p.prevFrom.toISOString(), to: p.from.toISOString() },
    buckets: p.buckets.map((b) => b.toISOString()),
    tickets: {
      opened: t.opened.out(),
      closed: t.closed.out(),
      done: t.done.out(),
      cancelled: t.cancelled.out(),
      reopened: t.reopened.out(),
      backlog: backlogOf(openState),
      cycleTime: durationSeries(cycleCur, cyclePrev, cycleBuckets),
      openAge,
    },
    messages: { comments: comments.out() },
    interactions: {
      total: i.total.out(),
      statusChanges: i.statusChanges.out(),
      assignments: i.assignments.out(),
      mentions: i.mentions.out(),
      dependencyEdits: i.dependencyEdits.out(),
      botPickups: i.botPickups.out(),
      botCompletions: i.botCompletions.out(),
      botsMentioned: i.botsMentioned.out(),
    },
    breakdown: breakdown.out(),
    projects: projectReports,
    contributors: { people: rank(people), bots: rank(bots) },
  };
}
