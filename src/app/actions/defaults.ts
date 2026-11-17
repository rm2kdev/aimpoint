"use server";

import { revalidatePath } from "next/cache";
import { cols } from "@/lib/db";
import { requireOrg } from "@/lib/session";
import { guard, UserError, type Result } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { orgPath } from "@/lib/paths";
import { loadOrgDefaults } from "@/lib/org-defaults";
import { newTaskStatusFor, setProjectNewTaskStatus } from "@/lib/project-defaults";
import { ObjectId } from "mongodb";
import { DEFAULT_STAGES, isDefaultStage, type NewTaskStatusSource, type OrgDefaults } from "@/lib/types";

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

export interface ProjectNewTaskStatus {
  /** The project's own override, or null when it inherits the org default. */
  newTaskStatusId: string | null;
  /** Where a person's new task without a status lands now (override or inherited), and why. */
  effectiveStatusId: string | null;
  source: NewTaskStatusSource;
}

/**
 * Sets (`statusId`, one of the project's own open statuses) or clears (null / "") a project's override of where
 * people's new tasks land (VEC-190). Admins only; another project's status id or a done/cancelled status is
 * refused and nothing changes. Open clients pick it up through org.changed (Project.newTaskStatusId).
 */
export async function saveProjectNewTaskStatus(slug: string, projectId: string, statusId: string | null): Promise<Result<ProjectNewTaskStatus>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    if (typeof projectId !== "string" || !ObjectId.isValid(projectId)) throw new UserError("That project no longer exists.");
    if (statusId !== null && typeof statusId !== "string") throw new UserError("Pick one of the project's statuses, or clear the override.");
    const c = await cols();
    const project = await c.projects.findOne({ _id: new ObjectId(projectId), orgId: org._id }, { projection: { _id: 1 } });
    if (!project) throw new UserError("That project no longer exists.");
    const saved = await setProjectNewTaskStatus(org._id, project._id, statusId || null);
    await publish(org._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString(), projectId: project._id.toHexString() });
    revalidatePath(orgPath(slug), "layout");
    const effective = await newTaskStatusFor(org._id, project._id);
    return { newTaskStatusId: saved?._id.toHexString() ?? null, effectiveStatusId: effective.status?._id.toHexString() ?? null, source: effective.source };
  });
}
