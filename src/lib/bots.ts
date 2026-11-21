import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cols } from "@/lib/db";
import type { BotAvatar, BotDoc, BotShape, OrgDoc } from "@/lib/types";
import { UserError } from "@/lib/result";
import { allowedTools } from "@/lib/mcp/catalog";
import { disabledKeyMessage, isBotEnabled } from "@/lib/bot-enabled";

export const BOT_SHAPES: BotShape[] = ["star", "heart", "flower", "cloud", "bolt", "moon", "blob", "ghost"];
export const BOT_COLORS = ["#2f6fed", "#30a46c", "#e5a00d", "#8b5cf6", "#e5484d", "#0ea5b7", "#d6409f", "#525252"];

/** API keys look like `vec_<43 url-safe chars>`; only a SHA-256 hash is stored. */
export function generateKey() {
  const key = `vec_${randomBytes(32).toString("base64url")}`;
  return { key, hash: hashKey(key), hint: `vec_…${key.slice(-4)}` };
}

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export function validateAvatar(orgId: string, a: unknown): BotAvatar {
  const v = a as Partial<BotAvatar> | undefined;
  if (v?.kind === "shape") {
    if (!BOT_SHAPES.includes(v.shape as BotShape)) throw new UserError("Pick a shape.");
    if (!/^#[0-9a-f]{6}$/i.test(v.color ?? "")) throw new UserError("Pick a colour.");
    return { kind: "shape", shape: v.shape as BotShape, color: v.color! };
  }
  if (v?.kind === "image") {
    const url = String(v.url ?? "");
    const local = url.startsWith(`/api/uploads/${orgId}-`);
    const blob = /^https:\/\/[a-z0-9-]+\.public\.blob\.vercel-storage\.com\/uploads\//.test(url) && url.includes(`/uploads/${orgId}-`);
    if (!local && !blob) throw new UserError("Upload the picture again.");
    return { kind: "image", url };
  }
  throw new UserError("Pick a picture or a shape.");
}

/**
 * Resolve the bot for an `Authorization: Bearer vec_…` header. null = no or unknown key (401). A disabled bot's key is
 * refused with a readable reason (403) and gets no lastUsedAt stamp, so a run already in flight can't change anything.
 */
export async function authenticateBot(req: Request): Promise<{ bot: BotDoc; org: OrgDoc } | BotAuthRefused | null> {
  const header = req.headers.get("authorization") ?? "";
  // OpenAI's MCP tool may send the token without the "Bearer" scheme; accept both.
  const m = /^(?:Bearer\s+)?(vec_[A-Za-z0-9_-]{20,})$/.exec(header.trim());
  if (!m) return null;
  const c = await cols();
  const bot = await c.bots.findOne({ keyHash: hashKey(m[1]) });
  if (!bot) return null;
  const org = await c.orgs.findOne({ _id: bot.orgId });
  if (!org) return null;
  // VEC-344: a disabled bot's key is refused before anything else, and isn't stamped as used.
  if (!isBotEnabled(bot)) return { refused: true, error: disabledKeyMessage(org.name) };
  // Best-effort usage stamp, at most every 15 seconds.
  if (!bot.lastUsedAt || Date.now() - bot.lastUsedAt.getTime() > 15_000) {
    c.bots.updateOne({ _id: bot._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return { bot, org };
}

/** A bot key that matched but can't be used: the bot is disabled (VEC-344). Callers answer 403 with `error`. */
export interface BotAuthRefused {
  refused: true;
  error: string;
}

/** The MCP tools this bot's role allows. A role that was deleted out from under the bot allows nothing. */
export async function toolsForBot(bot: BotDoc): Promise<Set<string>> {
  if (!bot.roleId) return allowedTools(null);
  const role = await (await cols()).botRoles.findOne({ _id: bot.roleId, orgId: bot.orgId });
  return allowedTools(role ?? { tools: {} });
}
