"use server";

import { revalidatePath } from "next/cache";
import { cols } from "@/lib/db";
import { requireOrg } from "@/lib/session";
import { guard, UserError, type Result } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { orgPath } from "@/lib/paths";
import { loadOrgDefaults } from "@/lib/org-defaults";
import { DEFAULT_STAGES, isDefaultStage, type OrgDefaults } from "@/lib/types";

/**
 * Saves the org's defaults (VEC-128). Admins only; the new-task stage must be an open stage
 * (backlog, triage, unstarted or started). Open clients pick the change up through org.changed.
 */
export async function saveDefaults(slug: string, input: { newTaskStage: string }): Promise<Result<OrgDefaults>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const stage = input?.newTaskStage;
    if (!isDefaultStage(stage)) throw new UserError(`New tasks can start in one of: ${DEFAULT_STAGES.join(", ")}.`);
    const c = await cols();
    await c.orgs.updateOne({ _id: org._id }, { $set: { "defaults.newTaskStage": stage } });
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
    return loadOrgDefaults(org._id);
  });
}
