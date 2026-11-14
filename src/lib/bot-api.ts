import "server-only";
import { ObjectId } from "mongodb";
import { authenticateBot } from "@/lib/bots";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import type { Actor } from "@/lib/task-service";
import type { BotDoc, OrgDoc } from "@/lib/types";

export interface BotCtx {
  bot: BotDoc;
  org: OrgDoc;
  actor: Actor;
}

/** Wraps a bot API handler: authenticates the Bearer key and maps errors to JSON. */
export function botRoute<P>(handler: (req: Request, ctx: BotCtx, params: P) => Promise<unknown>) {
  return async (req: Request, routeCtx: { params: Promise<P> }) => {
    const auth = await authenticateBot(req);
    if (!auth) {
      return Response.json(
        { error: "Missing or invalid API key. Send `Authorization: Bearer vec_…`." },
        { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
      );
    }
    try {
      const data = await handler(req, { ...auth, actor: { orgId: auth.org._id, id: auth.bot._id, isAdmin: false } }, await routeCtx.params);
      return data instanceof Response ? data : Response.json(data);
    } catch (err) {
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

/** Status by name (case-insensitive) or id. */
export async function resolveStatus(orgId: ObjectId, ref: unknown) {
  if (ref === undefined || ref === null || ref === "") return undefined;
  const c = await cols();
  const s = String(ref).trim();
  const statuses = await c.statuses.find({ orgId }).toArray();
  const st = statuses.find((x) => x._id.toHexString() === s) ?? statuses.find((x) => x.name.toLowerCase() === s.toLowerCase());
  if (!st) throw new UserError(`Unknown status "${s}". Use one of: ${statuses.map((x) => x.name).join(", ")}.`);
  return st._id.toHexString();
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
  if (v === "issue" || v === "feature") return v;
  throw new UserError("`type` is \"issue\" or \"feature\".");
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
