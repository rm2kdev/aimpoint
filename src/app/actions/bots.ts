"use server";

import { revalidatePath } from "next/cache";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { requireOrg } from "@/lib/session";
import { guard, UserError, type Result } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { publishWorking } from "@/lib/claims";
import { generateKey, hashKey, validateAvatar } from "@/lib/bots";
import { toBot } from "@/lib/data";
import { METHOD_IDS, backendFor } from "@/lib/bot-connect";
import { deliver, hermesProbe, providerProbe } from "@/lib/bot-dispatch";
import { seal, secretHint, unseal } from "@/lib/secrets";
import { connectionAimpointKeySealed, connectionAimpointUrl } from "@/lib/connection-fields";
import { BOT_MAX_TASKS_DEFAULT, BOT_MAX_TASKS_MAX, BOT_MAX_TASKS_MIN } from "@/lib/types";
import type { Bot, BotAgent, BotAvatar, BotConnectionDoc, BotMcpInstall, BotMethod } from "@/lib/types";
import { advanceMcpInstall, installRunning, preflightHermes, recordFailedInstall, startMcpInstall, toMcpInstall } from "@/lib/bot-mcp-install";
import { orgPath } from "@/lib/paths";
import { MCP_SERVER_NAME } from "@/lib/mcp-name";
import { flowOwnerRemoved } from "@/lib/flows";
import { assertOrgActive } from "@/lib/billing";
import { botEnabledFlipFilter, botEnabledUpdate, disabledWakeMessage, isBotEnabled } from "@/lib/bot-enabled";
import { wakeReEnabledBot } from "@/lib/wake-queue";

export interface BotInput {
  name: string;
  description: string;
  avatar: BotAvatar;
}

function clean(input: BotInput, orgId: string) {
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 40) throw new UserError("Bot names are 1-40 characters.");
  const description = String(input.description ?? "").trim();
  if (description.length > 280) throw new UserError("Keep the description under 280 characters.");
  return { name, description, avatar: validateAvatar(orgId, input.avatar) };
}

const botId = (id: string) => {
  if (!ObjectId.isValid(id)) throw new UserError("Unknown bot.");
  return new ObjectId(id);
};

/** Creates a bot and returns its API key. The key is only ever shown here and on reroll. */
export async function createBot(slug: string, input: BotInput): Promise<Result<{ bot: Bot; key: string }>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const data = clean(input, org._id.toHexString());
    assertOrgActive(org, { isAdmin: true });
    const { key, hash, hint } = generateKey();
    const now = new Date();
    const doc = { _id: new ObjectId(), orgId: org._id, ...data, maxTasks: BOT_MAX_TASKS_DEFAULT, mcpServerName: MCP_SERVER_NAME, keyHash: hash, keyHint: hint, keyRotatedAt: now, createdBy: user._id, createdAt: now };
    const c = await cols();
    await c.bots.insertOne(doc);
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
    return { bot: toBot(doc), key };
  });
}

export async function updateBot(slug: string, id: string, input: BotInput): Promise<Result<Bot>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const data = clean(input, org._id.toHexString());
    const c = await cols();
    const bot = await c.bots.findOneAndUpdate({ _id: botId(id), orgId: org._id }, { $set: data }, { returnDocument: "after" });
    if (!bot) throw new UserError("This bot no longer exists.");
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
    return toBot(bot);
  });
}

/** Sets how many tasks the bot works on at once. Display only for now: dispatch doesn't enforce it. */
export async function setBotMaxTasks(slug: string, id: string, value: number): Promise<Result<Bot>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    if (typeof value !== "number" || !Number.isInteger(value) || value < BOT_MAX_TASKS_MIN || value > BOT_MAX_TASKS_MAX) {
      throw new UserError(`Max concurrent tasks is a whole number from ${BOT_MAX_TASKS_MIN} to ${BOT_MAX_TASKS_MAX}.`);
    }
    const c = await cols();
    const bot = await c.bots.findOneAndUpdate({ _id: botId(id), orgId: org._id }, { $set: { maxTasks: value } }, { returnDocument: "after" });
    if (!bot) throw new UserError("This bot no longer exists.");
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
    return toBot(bot);
  });
}

/**
 * Switches a bot on or off (VEC-343). Admins only. A disabled bot stays in the org: its assignments, claims, history,
 * key and connection are kept (nothing is unassigned), it just isn't woken, offered or let in until it's enabled again
 * (enforced through lib/bot-enabled.ts, VEC-344). The doc records when and by whom (`disabledAt`, `disabledBy`).
 * Setting the state it's already in changes nothing and returns the bot as it is.
 */
export async function setBotEnabled(slug: string, id: string, enabled: boolean): Promise<Result<Bot>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    if (typeof enabled !== "boolean") throw new UserError("Say whether the bot should be enabled.");
    const c = await cols();
    const _id = botId(id);
    const bot = await c.bots.findOneAndUpdate(
      { _id, orgId: org._id, ...botEnabledFlipFilter(enabled) },
      botEnabledUpdate(enabled, user._id, new Date()),
      { returnDocument: "after" },
    );
    if (!bot) {
      const current = await c.bots.findOne({ _id, orgId: org._id });
      if (!current) throw new UserError("This bot no longer exists.");
      return toBot(current);
    }
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
    // VEC-344: back on, so the wake-ups it missed while disabled go out now (the held queue, like an unlocked org).
    if (enabled) wakeReEnabledBot(bot, org);
    return toBot(bot);
  });
}

/** Replaces the bot's key; the old key stops working immediately. */
export async function rerollBotKey(slug: string, id: string): Promise<Result<{ bot: Bot; key: string }>> {
  return guard(async () => {
    const { org } = await requireOrg(slug, { admin: true });
    const { key, hash, hint } = generateKey();
    const c = await cols();
    const bot = await c.bots.findOneAndUpdate(
      { _id: botId(id), orgId: org._id },
      { $set: { keyHash: hash, keyHint: hint, keyRotatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!bot) throw new UserError("This bot no longer exists.");
    // Providers that call Aimpoint on the bot's behalf hold a sealed copy of the key: keep it current.
    if (connectionAimpointKeySealed(bot.connection)) {
      await c.bots.updateOne(
        { _id: bot._id },
        { $set: { "connection.aimpointKeySealed": seal(key) }, $unset: { "connection.vectorKeySealed": "" } },
      );
    }
    revalidatePath(orgPath(slug, "settings", "bots", id));
    return { bot: toBot(bot), key };
  });
}

/** Deletes the bot and unassigns its tasks. Tasks it created keep their history. */
export async function deleteBot(slug: string, id: string): Promise<Result> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const c = await cols();
    const _id = botId(id);
    const doomed = await c.bots.findOne({ _id, orgId: org._id }, { projection: { name: 1 } });
    const res = await c.bots.deleteOne({ _id, orgId: org._id });
    if (!res.deletedCount) throw new UserError("This bot no longer exists.");
    // Flow steps it owned become unowned and say so; it stops resolving waits (VEC-174).
    await flowOwnerRemoved(org._id, "bot", _id, doomed?.name ?? "A deleted bot");
    // Tasks whose row changes for open clients: the bot's assigned ones and the ones it was working on.
    const [assigned, working, marked] = await Promise.all([
      c.tasks.find({ orgId: org._id, assigneeId: _id }, { projection: { _id: 1 } }).toArray(),
      c.agentClaims.find({ botId: _id, state: "in_progress" }, { projection: { taskId: 1 } }).toArray(),
      c.runMarks.find({ botId: _id }, { projection: { taskId: 1 } }).toArray(),
    ]);
    await c.tasks.updateMany({ orgId: org._id, assigneeId: _id }, { $set: { assigneeId: null, updatedAt: new Date() } });
    await Promise.all([c.agentClaims.deleteMany({ botId: _id }), c.runMarks.deleteMany({ botId: _id }), c.botMentions.deleteMany({ botId: _id })]);
    const touched = new Map([...assigned.map((t) => t._id), ...working.map((w) => w.taskId), ...marked.map((m) => m.taskId)].map((id) => [id.toHexString(), id]));
    await publishWorking(org._id, user._id, [...touched.values()], { workingOnly: false });
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
  });
}


/* ---------------- connection ---------------- */

export interface ConnectionInput {
  agent: BotAgent;
  method: BotMethod;
  url?: string;
  model?: string;
  /** New secret. Omit to keep the saved one (same method only). */
  secret?: string;
  /** The bot's Aimpoint key, for methods that hand it to a provider. */
  aimpointKey?: string;
  /** No key in hand: issue the bot a new one for the provider (the old one stops working). */
  rotateKey?: boolean;
  /** Aimpoint's origin as the browser sees it. */
  aimpointUrl?: string;
}

const isPrivateHost = (h: string) =>
  h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?$|\[?f[cd])/i.test(h);

/** Checks an outbound URL. Link-local and cloud metadata hosts are never allowed; private hosts only off Vercel. */
function cleanUrl(raw: string | undefined, label: string) {
  const s = String(raw ?? "").trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new UserError(`${label} has to be a full URL, like https://example.com.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new UserError(`${label} has to start with http:// or https://.`);
  const h = u.hostname.toLowerCase();
  if (/^169\.254\./.test(h) || h === "metadata.google.internal" || h.startsWith("[fe80")) throw new UserError(`${label} can't point at that address.`);
  if (process.env.VERCEL && isPrivateHost(h)) throw new UserError(`Aimpoint runs in the cloud and can't reach ${h}. Use a public address or a tunnel.`);
  return u.toString().replace(/\/+$/, "");
}

export async function saveBotConnection(slug: string, id: string, input: ConnectionInput): Promise<Result<{ bot: Bot; key?: string }>> {
  return guard(async () => {
    const { org } = await requireOrg(slug, { admin: true });
    if (!METHOD_IDS.includes(input.method)) throw new UserError("Pick a backend.");
    const m = backendFor(input.method);
    if (m.agent !== input.agent) throw new UserError("Pick a backend.");
    const c = await cols();
    const bot = await c.bots.findOne({ _id: botId(id), orgId: org._id });
    if (!bot) throw new UserError("This bot no longer exists.");
    const prev = bot.connection?.method === input.method ? bot.connection : null;

    const conn: BotConnectionDoc = { agent: input.agent, method: input.method, updatedAt: new Date() };
    let issued: ReturnType<typeof generateKey> | null = null;
    try {
      const v = new URL(String(input.aimpointUrl ?? ""));
      if (v.protocol === "http:" || v.protocol === "https:") conn.aimpointUrl = v.origin;
    } catch {}
    if (m.url) conn.url = cleanUrl(input.url, m.url.label);

    let secret = input.secret?.trim() || null;
    if (m.secret) {
      if (secret) {
        if (secret.length > 500) throw new UserError(`${m.secret.label} looks too long.`);
        conn.secretSealed = seal(secret);
        conn.secretHint = secretHint(secret);
      } else if (prev?.secretSealed) {
        conn.secretSealed = prev.secretSealed;
        conn.secretHint = prev.secretHint;
      } else throw new UserError(`Add the ${m.secret.label}.`);
    }
    if (m.model) {
      const model = (input.model?.trim() || m.model.default || "").slice(0, 100);
      if (!model) throw new UserError("Add the model id.");
      conn.model = model;
    }
    if (m.needsAimpointKey) {
      if (!conn.aimpointUrl || /^http:/.test(conn.aimpointUrl) || isPrivateHost(new URL(conn.aimpointUrl).hostname)) {
        throw new UserError(`${m.title} calls Aimpoint from its own servers, so Aimpoint needs a public https:// address. This one is ${conn.aimpointUrl ?? "unknown"}.`);
      }
      const vk = input.aimpointKey?.trim();
      if (vk) {
        if (hashKey(vk) !== bot.keyHash) throw new UserError("That isn't this bot's current key.");
        conn.aimpointKeySealed = seal(vk);
      } else if (connectionAimpointKeySealed(prev)) conn.aimpointKeySealed = connectionAimpointKeySealed(prev);
      else if (input.rotateKey) {
        issued = generateKey();
        conn.aimpointKeySealed = seal(issued.key);
      } else throw new UserError("This backend needs the bot's key.");
    }

    // Check push targets before saving, so a saved connection is a working one.
    if (input.method === "hermes-api") {
      const probe = await hermesProbe(conn.url!, secret ?? unseal(conn.secretSealed!) ?? "");
      if (!probe.ok) throw new UserError(probe.error);
    }
    if ((input.method === "claude-api" || input.method === "openai-api") && secret) {
      const probe = await providerProbe(input.method === "claude-api" ? "anthropic" : "openai", secret, conn.model!);
      if (!probe.ok) throw new UserError(probe.error);
    }
    secret = null;

    const set: Record<string, unknown> = { connection: conn };
    if (issued) Object.assign(set, { keyHash: issued.hash, keyHint: issued.hint, keyRotatedAt: new Date() });
    const saved = await c.bots.findOneAndUpdate({ _id: bot._id }, { $set: set }, { returnDocument: "after" });
    revalidatePath(orgPath(slug, "settings", "bots"), "layout");
    return { bot: toBot(saved!), key: issued?.key };
  });
}

/** Sends a test wake-up through a push connection and returns the outcome. */
export async function testBotConnection(slug: string, id: string): Promise<Result<Bot>> {
  return guard(async () => {
    const { org } = await requireOrg(slug, { admin: true });
    const c = await cols();
    const bot = await c.bots.findOne({ _id: botId(id), orgId: org._id });
    if (!bot?.connection) throw new UserError("Set up a connection first.");
    // VEC-344: a disabled bot isn't woken, not even by a test.
    if (!isBotEnabled(bot)) throw new UserError(disabledWakeMessage(bot.name));
    await deliver(bot, org, { kind: "test" });
    return toBot((await c.bots.findOne({ _id: bot._id }))!);
  });
}

export async function disconnectBot(slug: string, id: string): Promise<Result> {
  return guard(async () => {
    const { org } = await requireOrg(slug, { admin: true });
    const res = await (await cols()).bots.updateOne({ _id: botId(id), orgId: org._id }, { $unset: { connection: "" } });
    if (!res.matchedCount) throw new UserError("This bot no longer exists.");
    revalidatePath(orgPath(slug, "settings", "bots"), "layout");
  });
}

/** Is this the bot's current key? Lets the wizard reuse a key the admin kept. */
export async function checkBotKey(slug: string, id: string, key: string): Promise<Result<boolean>> {
  return guard(async () => {
    const { org } = await requireOrg(slug, { admin: true });
    const bot = await (await cols()).bots.findOne({ _id: botId(id), orgId: org._id }, { projection: { keyHash: 1 } });
    if (!bot) throw new UserError("This bot no longer exists.");
    return hashKey(String(key ?? "").trim()) === bot.keyHash;
  });
}

/** Last check-in, last wake-up and key hint (an MCP install can reroll the key), for the wizard's live checks. */
export async function getBotPulse(slug: string, id: string): Promise<Result<Pick<Bot, "lastUsedAt" | "connection" | "keyHint">>> {
  return guard(async () => {
    const { org } = await requireOrg(slug);
    const bot = await (await cols()).bots.findOne({ _id: botId(id), orgId: org._id });
    if (!bot) throw new UserError("This bot no longer exists.");
    const b = toBot(bot);
    return { lastUsedAt: b.lastUsedAt, connection: b.connection, keyHint: b.keyHint };
  });
}

/* ---------------- MCP install (VEC-169) ---------------- */

/**
 * Asks the bot's Hermes (Agent API connection) to add Aimpoint's MCP server to its own config, then checks that it
 * loaded it. Pass the bot's plaintext key when the wizard holds it (just created or rerolled); without one Aimpoint
 * rerolls the key for the install, and the old key stops working. Poll getBotMcpInstall for the outcome:
 * pending -> installed | failed (with a reason). The key is never stored, logged or returned.
 */
export async function installBotMcp(slug: string, id: string, input: { key?: string; aimpointUrl?: string } = {}): Promise<Result<BotMcpInstall>> {
  return guard(async () => {
    const { org } = await requireOrg(slug, { admin: true });
    const c = await cols();
    const bot = await c.bots.findOne({ _id: botId(id), orgId: org._id });
    if (!bot) throw new UserError("This bot no longer exists.");
    if (bot.connection?.method !== "hermes-api") throw new UserError("Connect this bot to Hermes over the Agent API first.");
    if (installRunning(bot.mcpInstall)) throw new UserError("An install is already running for this bot. Wait for it to finish.");
    let aimpointUrl = connectionAimpointUrl(bot.connection) ?? null;
    try {
      const v = new URL(String(input.aimpointUrl ?? ""));
      if (v.protocol === "http:" || v.protocol === "https:") aimpointUrl = v.origin;
    } catch {}
    if (!aimpointUrl) throw new UserError("Aimpoint doesn't know its own address for this connection. Run setup again.");

    let key = typeof input.key === "string" ? input.key.trim() : "";
    if (key && hashKey(key) !== bot.keyHash) throw new UserError("That isn't this bot's current key.");
    // Check Hermes answers before rerolling, so an unreachable Hermes doesn't cost the bot its working key.
    const down = await preflightHermes(bot);
    if (down) return toMcpInstall(await recordFailedInstall(bot, `Aimpoint couldn't reach Hermes: ${down}`));
    let rerolled = false;
    if (!key) {
      const issued = generateKey();
      await c.bots.updateOne({ _id: bot._id }, { $set: { keyHash: issued.hash, keyHint: issued.hint, keyRotatedAt: new Date() } });
      key = issued.key;
      rerolled = true;
    }
    const doc = await startMcpInstall(bot, org, key, { keyRerolled: rerolled, aimpointUrl });
    key = "";
    if (rerolled) revalidatePath(orgPath(slug, "settings", "bots", id));
    return toMcpInstall(doc);
  });
}

/** The latest install attempt (null = never), advanced one step if it's still pending. */
export async function getBotMcpInstall(slug: string, id: string): Promise<Result<BotMcpInstall | null>> {
  return guard(async () => {
    const { org } = await requireOrg(slug, { admin: true });
    const c = await cols();
    const bot = await c.bots.findOne({ _id: botId(id), orgId: org._id }, { projection: { mcpInstall: 1 } });
    if (!bot) throw new UserError("This bot no longer exists.");
    if (!bot.mcpInstall) return null;
    const d = bot.mcpInstall.state === "pending" ? await advanceMcpInstall(bot._id, bot.mcpInstall.id) : bot.mcpInstall;
    return d ? toMcpInstall(d) : null;
  });
}
