"use server";

import { AuthError, currentUser } from "@/lib/session";
import { guard, type Result } from "@/lib/result";
import { markChangelogSeen } from "@/lib/changelog";

// "What's new" pop-up (VEC-373). The marker is per person, not per org, so this needs no org slug, and it works
// while an org is locked (dismissing starts no work).

/**
 * Dismiss the "What's new" milestone `milestoneId` for the signed-in person. Idempotent and forward only:
 * dismissing twice, with an older id or with an unknown id leaves the marker as it is. Returns the marker after.
 */
export async function dismissChangelog(milestoneId: string): Promise<Result<{ seen: string | null }>> {
  return guard(async () => {
    const user = await currentUser();
    if (!user) throw new AuthError("You are signed out. Sign in and try again.");
    const id = typeof milestoneId === "string" ? milestoneId.slice(0, 100) : "";
    return { seen: await markChangelogSeen(user._id, id) };
  });
}
