import "server-only";
import { ObjectId } from "mongodb";
import { authenticateBot, toolsForBot } from "@/lib/bots";
import { cols } from "@/lib/db";
import { findTaskByKey } from "@/lib/data";
import { UserError } from "@/lib/result";
import { StoppedWorkError } from "@/lib/stop-guard";
import { resolveProjectStatus, statusFilterIds } from "@/lib/statuses";
import type { Actor } from "@/lib/task-service";
import { isTaskType, type BotDoc, type OrgDoc } from "@/lib/types";

export interface BotCtx {
  bot: BotDoc;
  org: OrgDoc;
  actor: Actor;
}

/**
 * Wraps a bot API handler: authenticates the Bearer key and maps errors to JSON.
 * `tool` names the MCP tool this endpoint is equivalent to, so a bot role that denies the tool
 * also denies the REST call.
 */
export function botRoute<P>(handler: (req: Request, ctx: BotCtx, params: P) => Promise<unknown>, tool?: string) {
  return async (req: Request, routeCtx: { params: Promise<P> }) => {
    const auth = await authenticateBot(req);
    if (!auth) {
      return Response.json(
        { error: "Missing or invalid API key. Send `Authorization: Bearer vec_…`." },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
      );
    }
    if (tool && !(await toolsForBot(auth.bot)).has(tool)) {
      return Response.json({ error: `${auth.bot.name}'s role doesn't allow ${tool}.` }, { status: 403 });
    }
    try {
      const data = await handler(req, { ...auth, actor: { orgId: auth.org._id, id: auth.bot._id, isAdmin: false, isBot: true } }, await routeCtx.params);
      return data instanceof Response ? data : Response.json(data);
    } catch (err) {
      // A person stopped this bot's work on the task (VEC-216): 409 with who and when.
      if (err instanceof StoppedWorkError) return Response.json({ error: err.message, stopped: err.stop }, { status: 409 });
      if (err instanceof UserError) {
        const status = /only the task's creator/i.test(err.message) ? 403 : /no longer exists|unknown task/i.test(err.message) ? 404 : 400;
        return Response.json({ error: err.message }, { status });
      }
      console.error("[bot api]", err);
      return Response.json({ error: "Something went wrong." }, { status: 500 });
    }
  };
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {}
  throw new UserError("Send a JSON object body.");
}

/** Project by key ("WEB") or id. */
export async function resolveProject(orgId: ObjectId, ref: unknown) {
  const c = await cols();
  const s = String(ref ?? "").trim();
  if (!s) throw new UserError("`project` is required (a project key like WEB, or its id).");
  const p = ObjectId.isValid(s) && s.length === 24
    ? await c.projects.findOne({ orgId, _id: new ObjectId(s) })
    : await c.projects.findOne({ orgId, key: s.toUpperCase() });
  if (!p) throw new UserError(`Unknown project "${s}".`);
  return p;
}

/**
 * Status for a write, by name (case-insensitive), stage or id, within `projectId`'s own statuses (VEC-115/116:
 * statuses are per project). A name or id of another project's status is a 400 naming both projects.
 * Undefined when not provided.
 */
export async function resolveStatus(orgId: ObjectId, ref: unknown, projectId: ObjectId) {
  if (ref === undefined || ref === null || ref === "") return undefined;
  if (typeof ref !== "string") throw new UserError("`status` is a status name or id (a string).");
  return (await resolveProjectStatus(orgId, projectId, ref))._id.toHexString();
}

/**
 * Status ids for a list filter: within `projectId` when the request names a project, else every project's
 * status of that name. Undefined when not provided.
 */
export async function resolveStatusFilter(orgId: ObjectId, ref: unknown, projectId?: ObjectId) {
  if (ref === undefined || ref === null || ref === "") return undefined;
  return statusFilterIds(orgId, String(ref), projectId);
}

/** Assignee by "me", null, user/bot id, member email or bot name. Returns undefined when not provided. */
export async function resolveAssignee(ctx: BotCtx, ref: unknown): Promise<string | null | undefined> {
  if (ref === undefined) return undefined;
  if (ref === null || ref === "") return null;
  const s = String(ref).trim();
  if (s === "me") return ctx.bot._id.toHexString();
  if (ObjectId.isValid(s) && s.length === 24) return s;
  const c = await cols();
  if (s.includes("@")) {
    const u = await c.users.findOne({ email: s.toLowerCase() });
    if (u && (await c.memberships.findOne({ orgId: ctx.org._id, userId: u._id }))) return u._id.toHexString();
  } else {
    const bots = await c.bots.find({ orgId: ctx.org._id }).toArray();
    const b = bots.find((x) => x.name.toLowerCase() === s.toLowerCase());
    if (b) return b._id.toHexString();
  }
  throw new UserError(`Unknown assignee "${s}". Use "me", a member's email, a bot's name or an id.`);
}

export function parsePriority(v: unknown) {
  if (v === undefined) return undefined;
  const map: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3 };
  const n = typeof v === "string" && v in map ? map[v] : Number(v);
  if (![0, 1, 2, 3].includes(n)) throw new UserError("`priority` is 0-3 or none/low/medium/high.");
  return n as 0 | 1 | 2 | 3;
}

export function parseType(v: unknown) {
  if (v === undefined) return undefined;
  if (isTaskType(v)) return v;
  throw new UserError("`type` is \"issue\", \"feature\" or \"task\".");
}

/** `dependsOn`: a list of task keys ("WEB-12") or ids -> ids. Undefined when not provided; null clears. */
export async function resolveTaskRefs(orgId: ObjectId, v: unknown): Promise<string[] | undefined> {
  if (v === undefined) return undefined;
  if (v === null) return [];
  if (!Array.isArray(v)) throw new UserError("`dependsOn` is a list of task keys like [\"WEB-12\"].");
  const c = await cols();
  const out: string[] = [];
  for (const raw of v) {
    const s = String(raw).trim();
    if (ObjectId.isValid(s) && s.length === 24 && (await c.tasks.findOne({ orgId, _id: new ObjectId(s) }, { projection: { _id: 1 } }))) {
      out.push(s);
      continue;
    }
    const found = await findTaskByKey(orgId, s);
    if (!found) throw new UserError(`Unknown task "${s}" in \`dependsOn\`.`);
    out.push(found.task._id.toHexString());
  }
  return out;
}

/** Plain text becomes paragraphs; HTML is passed through to the sanitiser. */
export function toDescriptionHtml(v: unknown) {
  if (v === undefined) return undefined;
  const s = String(v);
  if (/<[a-z][\s\S]*>/i.test(s)) return s;
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return s
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
