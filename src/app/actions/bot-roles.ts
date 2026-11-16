"use server";

import { revalidatePath } from "next/cache";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { requireOrg } from "@/lib/session";
import { guard, UserError, type Result } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { toBotRole } from "@/lib/data";
import { allToolsAllowed, TOOL_NAMES } from "@/lib/mcp/catalog";
import type { BotRole } from "@/lib/types";
import { orgPath } from "@/lib/paths";

export interface BotRoleInput {
  name: string;
  description: string;
  tools?: Record<string, boolean>;
}

const roleId = (id: string) => {
  if (!ObjectId.isValid(id)) throw new UserError("Unknown role.");
  return new ObjectId(id);
};

function clean(input: BotRoleInput) {
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 40) throw new UserError("Role names are 1-40 characters.");
  const description = String(input.description ?? "").trim();
  if (description.length > 280) throw new UserError("Keep the description under 280 characters.");
  return { name, description };
}

/** Only known tools are stored, as explicit allow (true) or deny (false). */
function cleanTools(tools: Record<string, boolean> | undefined) {
  return Object.fromEntries(TOOL_NAMES.map((n) => [n, tools?.[n] === true]));
}

export async function createBotRole(slug: string, input: BotRoleInput): Promise<Result<BotRole>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const now = new Date();
    const doc = {
      _id: new ObjectId(),
      orgId: org._id,
      ...clean(input),
      tools: input.tools ? cleanTools(input.tools) : allToolsAllowed(),
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    };
    await (await cols()).botRoles.insertOne(doc);
    revalidatePath(orgPath(slug, "settings", "bots"));
    return toBotRole(doc);
  });
}

export async function updateBotRole(slug: string, id: string, input: BotRoleInput): Promise<Result<BotRole>> {
  return guard(async () => {
    const { org } = await requireOrg(slug, { admin: true });
    const set = { ...clean(input), ...(input.tools ? { tools: cleanTools(input.tools) } : {}), updatedAt: new Date() };
    const role = await (await cols()).botRoles.findOneAndUpdate({ _id: roleId(id), orgId: org._id }, { $set: set }, { returnDocument: "after" });
    if (!role) throw new UserError("This role no longer exists.");
    revalidatePath(orgPath(slug, "settings"), "layout");
    return toBotRole(role);
  });
}

/** Refuses while bots still use the role, so deleting never silently widens or cuts a bot's access. */
export async function deleteBotRole(slug: string, id: string): Promise<Result> {
  return guard(async () => {
    const { org } = await requireOrg(slug, { admin: true });
    const c = await cols();
    const _id = roleId(id);
    const users = await c.bots.countDocuments({ orgId: org._id, roleId: _id });
    if (users) throw new UserError(`${users} bot${users === 1 ? " uses" : "s use"} this role. Give ${users === 1 ? "it" : "them"} another role first.`);
    const res = await c.botRoles.deleteOne({ _id, orgId: org._id });
    if (!res.deletedCount) throw new UserError("This role no longer exists.");
    revalidatePath(orgPath(slug, "settings"), "layout");
  });
}

/** null = no role: the bot sees every tool. */
export async function setBotRole(slug: string, botId: string, role: string | null): Promise<Result> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const c = await cols();
    let rid: ObjectId | null = null;
    if (role) {
      rid = roleId(role);
      if (!(await c.botRoles.findOne({ _id: rid, orgId: org._id }, { projection: { _id: 1 } }))) throw new UserError("This role no longer exists.");
    }
    if (!ObjectId.isValid(botId)) throw new UserError("Unknown bot.");
    const res = await c.bots.updateOne({ _id: new ObjectId(botId), orgId: org._id }, { $set: { roleId: rid } });
    if (!res.matchedCount) throw new UserError("This bot no longer exists.");
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug, "settings"), "layout");
  });
}
