"use server";

import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { requireOrg } from "@/lib/session";
import { guard, UserError, type Result } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import type { ProjectOrder } from "@/lib/project-order";

const MAX_IDS = 1000;

/**
 * Save the signed-in person's sidebar project order for this org (VEC-53). Any member may do it: the order
 * lives on their own membership, so teammates' sidebars don't change.
 *
 * `projectIds` is the order they want, top first. Refused: a non-array, non-string or malformed ids,
 * duplicates, and any id that is a project in another organisation. Ignored: ids of projects that no
 * longer exist (deleted meanwhile) and archived projects (hidden from the sidebar). Projects left out
 * follow the listed ones in createdAt order when the shell loads.
 *
 * Their other open tabs get a `projects.order` event (scoped to their userId, ignored by everyone else);
 * the calling tab has already applied it optimistically and keeps the returned `{ids, at}`.
 */
export async function reorderProjectsAction(orgSlug: string, projectIds: string[]): Promise<Result<ProjectOrder>> {
  return guard(async () => {
    const { org, user, membership } = await requireOrg(String(orgSlug ?? ""));
    if (!Array.isArray(projectIds)) throw new UserError("Send the projects as a list.");
    if (projectIds.length > MAX_IDS) throw new UserError("Too many projects.");
    const seen = new Set<string>();
    for (const id of projectIds) {
      if (typeof id !== "string" || !ObjectId.isValid(id) || id.length !== 24) throw new UserError("That isn't a project.");
      const k = id.toLowerCase();
      if (seen.has(k)) throw new UserError("A project is listed twice.");
      seen.add(k);
    }
    const ids = [...seen].map((id) => new ObjectId(id));
    const c = await cols();
    const found = await c.projects
      .find({ _id: { $in: ids } }, { projection: { _id: 1, orgId: 1, archivedAt: 1 } })
      .toArray();
    if (found.some((p) => !p.orgId.equals(org._id))) throw new UserError("That project isn't in this organisation.");
    const keep = new Set(found.filter((p) => !p.archivedAt).map((p) => p._id.toHexString()));
    const order = ids.filter((id) => keep.has(id.toHexString()));

    const now = new Date();
    const r = await c.memberships.updateOne(
      { _id: membership._id, orgId: org._id, userId: user._id },
      { $set: { projectOrder: order, projectOrderAt: now } },
    );
    if (!r.matchedCount) throw new UserError("You aren't a member of this organisation.");

    const saved: ProjectOrder = { ids: order.map((id) => id.toHexString()), at: now.getTime() };
    await publish(org._id.toHexString(), { type: "projects.order", userId: user._id.toHexString(), projectIds: saved.ids, at: saved.at });
    return saved;
  });
}
