import "server-only";
import type { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { MILESTONES } from "@/content/changelog";
import {
  latestMilestone,
  nextSeenMarker,
  shouldShowChangelog,
  unseenMilestones,
  type ChangelogMilestone,
} from "@/lib/changelog-core";
import type { UserDoc } from "@/lib/types";

// Server side of the "What's new" changelog (VEC-373). Rules live in lib/changelog-core.ts; docs/changelog.md.

/**
 * The milestone the signed-in person's pop-up should show, or null. Reads only the user doc the org layout
 * already loaded (requireOrgPage), so it costs no query and arrives with the shell on every org page.
 */
export function changelogFor(user: Pick<UserDoc, "changelogSeen" | "createdAt">): ChangelogMilestone | null {
  return shouldShowChangelog(MILESTONES, user.changelogSeen, user.createdAt);
}

/**
 * How many milestones the signed-in person hasn't seen (VEC-388), for the sidebar's What's new badge. Same rule
 * and the same user doc as changelogFor (no query): milestones after their seen marker that were released after
 * the account was created. 0 whenever changelogFor is null. Dismissing the newest one clears them all, because the
 * marker moves to it and every older id sorts before it.
 */
export function changelogUnseenCount(user: Pick<UserDoc, "changelogSeen" | "createdAt">): number {
  return unseenMilestones(MILESTONES, user.changelogSeen, user.createdAt).length;
}

/** The marker to stamp on a brand-new account: the newest milestone at signup (none shipped = unset). */
export function changelogSeenAtSignup(): { changelogSeen: string } | Record<string, never> {
  const latest = latestMilestone(MILESTONES);
  return latest ? { changelogSeen: latest.id } : {};
}

/**
 * Record that the person dismissed milestone `id`. Forward only and idempotent: unknown ids, the current marker
 * and older ids change nothing. The conditional update keeps it forward-only across concurrent tabs too.
 * Returns the marker afterwards.
 */
export async function markChangelogSeen(userId: ObjectId, id: string): Promise<string | null> {
  const { users } = await cols();
  if (nextSeenMarker(MILESTONES, null, id) === null) {
    const u = await users.findOne({ _id: userId }, { projection: { changelogSeen: 1 } });
    return u?.changelogSeen ?? null;
  }
  await users.updateOne(
    { _id: userId, $or: [{ changelogSeen: { $exists: false } }, { changelogSeen: null }, { changelogSeen: { $lt: id } }] },
    { $set: { changelogSeen: id } },
  );
  const u = await users.findOne({ _id: userId }, { projection: { changelogSeen: 1 } });
  return u?.changelogSeen ?? null;
}
