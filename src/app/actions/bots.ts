"use server";

import { revalidatePath } from "next/cache";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { requireOrg } from "@/lib/session";
import { guard, UserError, type Result } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { generateKey, validateAvatar } from "@/lib/bots";
import { toBot } from "@/lib/data";
import type { Bot, BotAvatar } from "@/lib/types";

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
    const { key, hash, hint } = generateKey();
    const now = new Date();
    const doc = { _id: new ObjectId(), orgId: org._id, ...data, keyHash: hash, keyHint: hint, keyRotatedAt: now, createdBy: user._id, createdAt: now };
    const c = await cols();
    await c.bots.insertOne(doc);
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(`/${slug}`, "layout");
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
    revalidatePath(`/${slug}`, "layout");
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
    revalidatePath(`/${slug}/bots/${id}`);
    return { bot: toBot(bot), key };
  });
}

/** Deletes the bot and unassigns its tasks. Tasks it created keep their history. */
export async function deleteBot(slug: string, id: string): Promise<Result> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const c = await cols();
    const _id = botId(id);
    const res = await c.bots.deleteOne({ _id, orgId: org._id });
    if (!res.deletedCount) throw new UserError("This bot no longer exists.");
    await c.tasks.updateMany({ orgId: org._id, assigneeId: _id }, { $set: { assigneeId: null, updatedAt: new Date() } });
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(`/${slug}`, "layout");
  });
}
