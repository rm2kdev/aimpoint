"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ObjectId } from "mongodb";
import { nanoid } from "nanoid";
import { z } from "zod";
import { cols } from "@/lib/db";
import { DEFAULT_STATUSES, PROJECT_COLORS } from "@/lib/data";
import { requireOrg, requireUser } from "@/lib/session";
import { guard, UserError, deriveKey, type Result } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { detachDeleted, recomputeOrg } from "@/lib/dependencies";
import { isClosedCategory, type ProjectDoc, type ProjectMetaEntry, type Role, type StatusCategory } from "@/lib/types";
import { orgPath } from "@/lib/paths";
import { removeMembership } from "@/lib/membership";

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org"
  );
}

const keySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, "Keys are 2-10 letters or digits, starting with a letter.");

/* ---------------- organisations ---------------- */

export type OnboardState = { error?: string } | undefined;

export async function createOrgAction(_: OnboardState, form: FormData): Promise<OnboardState> {
  const user = await requireUser();
  const name = String(form.get("name") ?? "").trim();
  const projectName = String(form.get("project") ?? "").trim() || "General";
  if (!name) return { error: "Name your organisation." };
  if (name.length > 60) return { error: "Keep the organisation name under 60 characters." };
  const c = await cols();
  const base = slugify(name);
  let slug = base;
  for (let i = 0; await c.orgs.findOne({ slug }); i++) slug = `${base}-${nanoid(4).toLowerCase()}`;
  const orgId = new ObjectId();
  const now = new Date();
  await c.orgs.insertOne({ _id: orgId, name, slug, createdAt: now });
  await c.memberships.insertOne({ _id: new ObjectId(), orgId, userId: user._id, role: "admin", createdAt: now });
  await c.statuses.insertMany(DEFAULT_STATUSES.map((s) => ({ ...s, _id: new ObjectId(), orgId })));
  await c.projects.insertOne({
    _id: new ObjectId(),
    orgId,
    name: projectName,
    key: deriveKey(projectName),
    color: PROJECT_COLORS[0],
    nextNumber: 1,
    createdAt: now,
  });
  redirect(orgPath(slug, "my"));
}

export async function renameOrg(slug: string, name: string): Promise<Result> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    name = name.trim();
    if (!name || name.length > 60) throw new UserError("Organisation names are 1-60 characters.");
    const c = await cols();
    await c.orgs.updateOne({ _id: org._id }, { $set: { name } });
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
  });
}

/* ---------------- projects ---------------- */

export async function createProject(slug: string, input: { name: string; key?: string }): Promise<Result<{ key: string; id: string }>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const name = input.name.trim();
    if (!name || name.length > 60) throw new UserError("Project names are 1-60 characters.");
    const keyParsed = keySchema.safeParse(input.key?.trim() ? input.key : deriveKey(name));
    if (!keyParsed.success) throw new UserError(keyParsed.error.issues[0].message);
    const c = await cols();
    if (await c.projects.findOne({ orgId: org._id, key: keyParsed.data }, { projection: { _id: 1 } })) {
      throw new UserError(`${keyParsed.data} is already used by another project. Pick a different key.`);
    }
    const count = await c.projects.countDocuments({ orgId: org._id });
    const id = new ObjectId();
    await c.projects.insertOne({
      _id: id,
      orgId: org._id,
      name,
      key: keyParsed.data,
      color: PROJECT_COLORS[count % PROJECT_COLORS.length],
      nextNumber: 1,
      createdAt: new Date(),
    });
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
    return { key: keyParsed.data, id: id.toHexString() };
  });
}

const META_MAX = 50;
const META_KEY_MAX = 64;
const META_VALUE_MAX = 4000;

/** Free-form key/value context for agents. Blank rows are dropped; keys must be unique (case-insensitive). */
function cleanMetadata(input: unknown): ProjectMetaEntry[] {
  if (!Array.isArray(input)) throw new UserError("Project context must be a list of key/value pairs.");
  const out: ProjectMetaEntry[] = [];
  const seen = new Set<string>();
  for (const raw of input as { key?: unknown; value?: unknown }[]) {
    const key = String(raw?.key ?? "").trim();
    const value = String(raw?.value ?? "").replace(/\r\n?/g, "\n").trim();
    if (!key && !value) continue;
    if (!key) throw new UserError("Every value needs a key.");
    if (key.length > META_KEY_MAX) throw new UserError(`Keys are up to ${META_KEY_MAX} characters.`);
    if (value.length > META_VALUE_MAX) throw new UserError(`Values are up to ${META_VALUE_MAX.toLocaleString()} characters ("${key}" is too long).`);
    if (seen.has(key.toLowerCase())) throw new UserError(`"${key}" is listed twice. Keys must be unique.`);
    seen.add(key.toLowerCase());
    out.push({ key, value });
  }
  if (out.length > META_MAX) throw new UserError(`A project can have up to ${META_MAX} context entries.`);
  return out;
}

export async function updateProject(
  slug: string,
  projectId: string,
  input: { name?: string; color?: string; metadata?: ProjectMetaEntry[] },
): Promise<Result> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const set: Partial<Pick<ProjectDoc, "name" | "color" | "metadata">> = {};
    if (input.name !== undefined) {
      const n = input.name.trim();
      if (!n || n.length > 60) throw new UserError("Project names are 1-60 characters.");
      set.name = n;
    }
    if (input.color && /^#[0-9a-f]{6}$/i.test(input.color)) set.color = input.color;
    if (input.metadata !== undefined) set.metadata = cleanMetadata(input.metadata);
    if (!Object.keys(set).length) return;
    const c = await cols();
    const r = await c.projects.updateOne({ _id: oidOrThrow(projectId), orgId: org._id }, { $set: set });
    if (!r.matchedCount) throw new UserError("This project no longer exists.");
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
  });
}

export async function setProjectArchived(slug: string, projectId: string, archived: boolean): Promise<Result> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const c = await cols();
    const pid = oidOrThrow(projectId);
    if (archived && (await c.projects.countDocuments({ orgId: org._id, archivedAt: null, _id: { $ne: pid } })) < 1) {
      throw new UserError("An organisation needs at least one active project for new tasks.");
    }
    const r = await c.projects.updateOne({ _id: pid, orgId: org._id }, { $set: { archivedAt: archived ? new Date() : null } });
    if (!r.matchedCount) throw new UserError("This project no longer exists.");
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
  });
}

/** Deletes a project and every task in it, with their comments and activity. `confirmKey` must match the project key. */
export async function deleteProject(slug: string, projectId: string, confirmKey: string): Promise<Result> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const c = await cols();
    const pid = oidOrThrow(projectId);
    const project = await c.projects.findOne({ _id: pid, orgId: org._id });
    if (!project) throw new UserError("This project no longer exists.");
    if (confirmKey.trim().toUpperCase() !== project.key) throw new UserError(`Type ${project.key} to confirm.`);
    if ((await c.projects.countDocuments({ orgId: org._id, archivedAt: null, _id: { $ne: pid } })) < 1) {
      throw new UserError("An organisation needs at least one active project. Create or restore another one first.");
    }
    const taskIds = (await c.tasks.find({ orgId: org._id, projectId: pid }, { projection: { _id: 1 } }).toArray()).map((t) => t._id);
    if (taskIds.length) {
      // Tasks in other projects that waited on these stop waiting.
      await detachDeleted(org._id, { id: user._id, name: async () => user.name }, taskIds);
      await Promise.all([
        c.notifications.deleteMany({ taskId: { $in: taskIds } }),
        c.comments.deleteMany({ taskId: { $in: taskIds } }),
        c.activity.deleteMany({ taskId: { $in: taskIds } }),
        c.agentClaims.deleteMany({ taskId: { $in: taskIds } }),
        c.botMentions.deleteMany({ taskId: { $in: taskIds } }),
      ]);
      await c.tasks.deleteMany({ orgId: org._id, projectId: pid });
    }
    await c.projects.deleteOne({ _id: pid, orgId: org._id });
    const orgHex = org._id.toHexString();
    const actorId = user._id.toHexString();
    // Open task lists drop the tasks live; anything else catches up on the org refresh.
    if (taskIds.length <= 200) for (const id of taskIds) await publish(orgHex, { type: "task.delete", actorId, taskId: id.toHexString() });
    await publish(orgHex, { type: "org.changed", actorId });
    revalidatePath(orgPath(slug), "layout");
  });
}

function oidOrThrow(id: string) {
  if (!ObjectId.isValid(id)) throw new UserError("This project no longer exists.");
  return new ObjectId(id);
}

/* ---------------- statuses ---------------- */

const CATEGORIES: StatusCategory[] = ["backlog", "triage", "unstarted", "started", "done", "cancelled"];

export async function saveStatus(
  slug: string,
  input: { id?: string; name: string; color: string; category: StatusCategory },
): Promise<Result> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const name = input.name.trim();
    if (!name || name.length > 40) throw new UserError("Status names are 1-40 characters.");
    if (!/^#[0-9a-f]{6}$/i.test(input.color)) throw new UserError("Pick a colour.");
    if (!CATEGORIES.includes(input.category)) throw new UserError("Pick a stage.");
    const c = await cols();
    if (input.id) {
      const prev = await c.statuses.findOneAndUpdate({ _id: new ObjectId(input.id), orgId: org._id }, { $set: { name, color: input.color, category: input.category } });
      // A status that starts or stops counting as closed (done or cancelled) releases or re-blocks the tasks that depend on its tasks.
      if (prev && isClosedCategory(prev.category) !== isClosedCategory(input.category)) await recomputeOrg(org._id, { id: user._id, name: async () => user.name });
    } else {
      const last = await c.statuses.find({ orgId: org._id }).sort({ order: -1 }).limit(1).next();
      await c.statuses.insertOne({ _id: new ObjectId(), orgId: org._id, name, color: input.color, category: input.category, order: (last?.order ?? -1) + 1 });
    }
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
  });
}

export async function reorderStatuses(slug: string, ids: string[]): Promise<Result> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const c = await cols();
    await c.statuses.bulkWrite(
      ids.map((id, order) => ({ updateOne: { filter: { _id: new ObjectId(id), orgId: org._id }, update: { $set: { order } } } })),
    );
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
  });
}

export async function deleteStatus(slug: string, id: string, moveTo: string): Promise<Result> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    if (id === moveTo) throw new UserError("Pick a different status to move tasks to.");
    const c = await cols();
    const target = await c.statuses.findOne({ _id: new ObjectId(moveTo), orgId: org._id });
    if (!target) throw new UserError("Pick a status to move tasks to.");
    const sid = new ObjectId(id);
    const removed = await c.statuses.findOne({ _id: sid, orgId: org._id });
    await c.tasks.updateMany({ orgId: org._id, statusId: sid }, { $set: { statusId: target._id, updatedAt: new Date() } });
    await c.statuses.deleteOne({ _id: sid, orgId: org._id });
    if (removed && isClosedCategory(removed.category) !== isClosedCategory(target.category)) await recomputeOrg(org._id, { id: user._id, name: async () => user.name });
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
  });
}

/* ---------------- members & invites ---------------- */

export async function createInvite(slug: string, email: string, role: Role): Promise<Result<{ url: string }>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const parsed = z.string().trim().toLowerCase().email().safeParse(email);
    if (!parsed.success) throw new UserError("Enter a valid email address.");
    if (role !== "admin" && role !== "member") throw new UserError("Pick a role.");
    const c = await cols();
    const existingUser = await c.users.findOne({ email: parsed.data });
    if (existingUser && (await c.memberships.findOne({ orgId: org._id, userId: existingUser._id }))) {
      throw new UserError("That person is already a member.");
    }
    const token = nanoid(32);
    const now = new Date();
    await c.invites.deleteMany({ orgId: org._id, email: parsed.data, acceptedAt: { $exists: false } });
    await c.invites.insertOne({
      _id: new ObjectId(),
      orgId: org._id,
      email: parsed.data,
      role,
      token,
      invitedBy: user._id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 14 * 864e5),
    });
    revalidatePath(orgPath(slug, "settings", "members"));
    return { url: `/invite/${token}` };
  });
}

export async function revokeInvite(slug: string, inviteId: string): Promise<Result> {
  return guard(async () => {
    const { org } = await requireOrg(slug, { admin: true });
    const c = await cols();
    await c.invites.deleteOne({ _id: new ObjectId(inviteId), orgId: org._id });
    revalidatePath(orgPath(slug, "settings", "members"));
  });
}

async function adminCount(orgId: ObjectId) {
  const c = await cols();
  return c.memberships.countDocuments({ orgId, role: "admin" });
}

export async function setMemberRole(slug: string, userId: string, role: Role): Promise<Result> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    if (role !== "admin" && role !== "member") throw new UserError("Pick a role.");
    const c = await cols();
    const uid = new ObjectId(userId);
    const m = await c.memberships.findOne({ orgId: org._id, userId: uid });
    if (!m) throw new UserError("That person isn't a member.");
    if (m.role === "admin" && role === "member" && (await adminCount(org._id)) <= 1) {
      throw new UserError("An organisation needs at least one admin.");
    }
    await c.memberships.updateOne({ _id: m._id }, { $set: { role } });
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
  });
}

export async function removeMember(slug: string, userId: string): Promise<Result> {
  return guard(async () => {
    const { org, user, isAdmin } = await requireOrg(slug);
    const self = user._id.toHexString() === userId;
    if (!self && !isAdmin) throw new UserError("Only admins can remove members.");
    if (!ObjectId.isValid(userId)) throw new UserError("That person isn't a member.");
    await removeMembership(org._id, new ObjectId(userId), user._id);
    revalidatePath(orgPath(slug), "layout");
  });
}

export async function acceptInvite(token: string): Promise<Result<{ slug: string }>> {
  return guard(async () => {
    const user = await requireUser();
    const c = await cols();
    const invite = await c.invites.findOne({ token });
    if (!invite || invite.acceptedAt || invite.expiresAt < new Date()) throw new UserError("This invite link has expired or was already used.");
    const org = await c.orgs.findOne({ _id: invite.orgId });
    if (!org) throw new UserError("This organisation no longer exists.");
    await c.memberships.updateOne(
      { orgId: org._id, userId: user._id },
      { $setOnInsert: { _id: new ObjectId(), orgId: org._id, userId: user._id, role: invite.role, createdAt: new Date() } },
      { upsert: true },
    );
    await c.invites.updateOne({ _id: invite._id }, { $set: { acceptedAt: new Date() } });
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    return { slug: org.slug };
  });
}
