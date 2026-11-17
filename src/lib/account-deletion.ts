import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { removeMembership } from "@/lib/membership";
import { deleteAvatar, deleteOrgImages } from "@/lib/storage";

/**
 * Account deletion (VEC-48). The account page shows the plan up front, and `deleteAccount` re-checks it
 * server-side after re-authentication:
 *  - `blocked`: orgs where the user is the only admin and other people are still members. Deletion is
 *    refused until they promote someone (or delete the org), so no org is ever left without an admin.
 *  - `soleOrgs`: orgs where the user is the only member (bots don't count). Those are deleted with the
 *    account, all their data included, but only when the user explicitly agreed to it.
 */
export interface DeletionPlanOrg {
  id: string;
  name: string;
}
export interface DeletionPlan {
  blocked: DeletionPlanOrg[];
  soleOrgs: DeletionPlanOrg[];
  /** Orgs they just leave (their open tasks there become unassigned). */
  leaves: DeletionPlanOrg[];
}

export async function accountDeletionPlan(userId: ObjectId): Promise<DeletionPlan> {
  const c = await cols();
  const memberships = await c.memberships.find({ userId }).sort({ createdAt: 1 }).toArray();
  const orgIds = memberships.map((m) => m.orgId);
  const [orgs, counts] = await Promise.all([
    c.orgs.find({ _id: { $in: orgIds } }, { projection: { name: 1 } }).toArray(),
    c.memberships
      .aggregate<{ _id: ObjectId; members: number; admins: number }>([
        { $match: { orgId: { $in: orgIds } } },
        { $group: { _id: "$orgId", members: { $sum: 1 }, admins: { $sum: { $cond: [{ $eq: ["$role", "admin"] }, 1, 0] } } } },
      ])
      .toArray(),
  ]);
  const plan: DeletionPlan = { blocked: [], soleOrgs: [], leaves: [] };
  for (const m of memberships) {
    const org = orgs.find((o) => o._id.equals(m.orgId));
    const n = counts.find((x) => x._id.equals(m.orgId));
    if (!org || !n) continue;
    const ref = { id: org._id.toHexString(), name: org.name };
    if (n.members <= 1) plan.soleOrgs.push(ref);
    else if (m.role === "admin" && n.admins <= 1) plan.blocked.push(ref);
    else plan.leaves.push(ref);
  }
  return plan;
}

const names = (orgs: DeletionPlanOrg[]) =>
  orgs.length === 1 ? orgs[0].name : `${orgs.slice(0, -1).map((o) => o.name).join(", ")} and ${orgs[orgs.length - 1].name}`;

export function blockedReason(blocked: DeletionPlanOrg[]) {
  return `You're the only admin of ${names(blocked)}, which still ${blocked.length === 1 ? "has" : "have"} other members. Promote someone else to admin there (or delete the organisation) first.`;
}

/**
 * Delete an organisation and everything in it: projects, tasks with their comments, activity, claims and
 * mentions, statuses, bots and bot roles, invites, notifications, memberships and uploaded images.
 * Only used for orgs whose sole member is deleting their account, so nobody else is watching it.
 */
export async function deleteOrganisationCascade(orgId: ObjectId, actorId: ObjectId) {
  const c = await cols();
  const taskIds = (await c.tasks.find({ orgId }, { projection: { _id: 1 } }).toArray()).map((t) => t._id);
  const botIds = (await c.bots.find({ orgId }, { projection: { _id: 1 } }).toArray()).map((b) => b._id);
  await Promise.all([
    c.comments.deleteMany({ taskId: { $in: taskIds } }),
    c.activity.deleteMany({ orgId }),
    c.agentClaims.deleteMany({ $or: [{ taskId: { $in: taskIds } }, { botId: { $in: botIds } }] }),
    c.botMentions.deleteMany({ $or: [{ taskId: { $in: taskIds } }, { botId: { $in: botIds } }] }),
    c.notifications.deleteMany({ orgId }),
    c.invites.deleteMany({ orgId }),
    c.statuses.deleteMany({ orgId }),
    c.flows.deleteMany({ orgId }),
    c.projectForms.deleteMany({ orgId }),
    c.botRoles.deleteMany({ orgId }),
    c.bots.deleteMany({ orgId }),
  ]);
  await c.tasks.deleteMany({ orgId });
  await c.projects.deleteMany({ orgId });
  await c.memberships.deleteMany({ orgId });
  await c.orgs.deleteOne({ _id: orgId });
  await c.deletedUsers.updateMany({ orgIds: orgId }, { $pull: { orgIds: orgId } });
  await deleteOrgImages(orgId.toHexString());
  // Any other tab still open on it (the user's own) refreshes into a 404.
  await publish(orgId.toHexString(), { type: "org.changed", actorId: actorId.toHexString() });
}

/**
 * Delete the user's account. The caller has already re-authenticated them. Refuses (UserError) when the
 * plan has blocked orgs, or sole-member orgs the user didn't agree to delete. Then: delete those orgs,
 * leave every other org (removeMembership unassigns open tasks with activity and broadcasts), drop their
 * notifications, invites, login challenges and picture, record a tombstone so their old tasks, comments
 * and activity render as "Deleted user", and delete the user doc. Deleting the doc ends every session:
 * the jwt callback and the realtime stream both drop a token whose user no longer exists. The email is free
 * to sign up again.
 */
export async function deleteAccount(userId: ObjectId, { deleteSoleOrgs }: { deleteSoleOrgs: boolean }) {
  const c = await cols();
  const user = await c.users.findOne({ _id: userId }, { projection: { email: 1, image: 1 } });
  if (!user) throw new UserError("Your account couldn't be found. Sign in again.");
  const plan = await accountDeletionPlan(userId);
  if (plan.blocked.length) throw new UserError(blockedReason(plan.blocked));
  if (plan.soleOrgs.length && !deleteSoleOrgs) {
    throw new UserError(
      `You're the only member of ${names(plan.soleOrgs)}. Agree to delete ${plan.soleOrgs.length === 1 ? "it" : "them"} with your account, or invite someone and make them admin first.`,
    );
  }

  // Leave first: removeMembership re-checks the last-admin rule against the live data and throws before
  // anything is deleted if an admin was demoted in the meantime.
  for (const o of plan.leaves) await removeMembership(new ObjectId(o.id), userId, userId);
  for (const o of plan.soleOrgs) await deleteOrganisationCascade(new ObjectId(o.id), userId);

  // Organisations where their id can still show up: ones they just left, plus anywhere they created tasks,
  // commented, were mentioned, acted or caused a notification (they may have left those earlier).
  const soleIds = new Set(plan.soleOrgs.map((o) => o.id));
  const found = await Promise.all([
    c.tasks.distinct("orgId", { $or: [{ createdBy: userId }, { assigneeId: userId }] }),
    c.activity.distinct("orgId", { actorId: userId }),
    c.comments.distinct("orgId", { $or: [{ authorId: userId }, { mentions: userId }] }),
    c.notifications.distinct("orgId", { actorId: userId }),
  ]);
  const orgIds = [...new Map([...plan.leaves.map((o) => new ObjectId(o.id)), ...found.flat()].map((id) => [id.toHexString(), id])).values()].filter(
    (id) => !soleIds.has(id.toHexString()),
  );
  await c.deletedUsers.updateOne({ _id: userId }, { $set: { orgIds, deletedAt: new Date() } }, { upsert: true });

  await Promise.all([
    c.notifications.deleteMany({ userId }),
    c.invites.deleteMany({ $or: [{ invitedBy: userId, acceptedAt: { $exists: false } }, { email: user.email }] }),
    c.loginChallenges.deleteMany({ userId }),
    c.memberships.deleteMany({ userId }),
  ]);
  await c.users.deleteOne({ _id: userId });
  await deleteAvatar(user.image);

  // Lists, panes and comments in every org that shows their name re-render with "Deleted user".
  const actorId = userId.toHexString();
  await Promise.all(orgIds.map((id) => publish(id.toHexString(), { type: "org.changed", actorId })));
  return { deletedOrgs: plan.soleOrgs.map((o) => o.name) };
}
