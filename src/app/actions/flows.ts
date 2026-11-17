"use server";

import { revalidatePath } from "next/cache";
import { ObjectId } from "mongodb";
import { requireOrg } from "@/lib/session";
import { guard, UserError, type Result } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { orgPath } from "@/lib/paths";
import { isFlowMode, type FlowMode } from "@/lib/flow-model";
import {
  loadOrgFlowSettings,
  loadProjectFlowSettings,
  writeOrgFlow,
  writeOrgFlowReset,
  writeProjectFlow,
  writeProjectFlowMode,
  writeProjectFlowReset,
  type OrgFlowSettings,
  type ProjectFlowSettings,
} from "@/lib/flows";

/**
 * Flow settings (VEC-174, docs/flows.md). Admins edit the org default flow and each project's flow; every
 * write is validated in lib/flow-model.ts (statuses of the project, owners that are org members or org bots)
 * and announced with org.changed (with projectId for a project's flow) so open editors and, later, the flow
 * engine's readers pick it up.
 */

function projectOid(id: string) {
  if (!id || !ObjectId.isValid(id)) throw new UserError("That project no longer exists.");
  return new ObjectId(id);
}

async function announce(slug: string, orgId: ObjectId, actorId: ObjectId, projectId?: ObjectId) {
  await publish(orgId.toHexString(), { type: "org.changed", actorId: actorId.toHexString(), ...(projectId ? { projectId: projectId.toHexString() } : {}) });
  revalidatePath(orgPath(slug), "layout");
}

/** The org default flow, for the editor. Any member may read it (bots see it through get_workspace). */
export async function getOrgFlow(slug: string): Promise<Result<OrgFlowSettings>> {
  return guard(async () => {
    const { org } = await requireOrg(slug);
    return loadOrgFlowSettings(org._id);
  });
}

/** A project's flow mode, own steps and resolved flow. */
export async function getProjectFlow(slug: string, projectId: string): Promise<Result<ProjectFlowSettings>> {
  return guard(async () => {
    const { org } = await requireOrg(slug);
    return loadProjectFlowSettings(org._id, projectOid(projectId));
  });
}

/** Saves the org default flow (stage + preferred status name per step). Projects that inherit follow at once. */
export async function saveOrgFlow(slug: string, steps: unknown): Promise<Result<OrgFlowSettings>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    await writeOrgFlow(org._id, user._id, steps);
    await announce(slug, org._id, user._id);
    return loadOrgFlowSettings(org._id);
  });
}

/** Puts the org default flow back to the seeded default (Triage, Build, optional Review, Done). */
export async function resetOrgFlow(slug: string): Promise<Result<OrgFlowSettings>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    await writeOrgFlowReset(org._id, user._id);
    await announce(slug, org._id, user._id);
    return loadOrgFlowSettings(org._id);
  });
}

/** Saves a project's own flow (exact statuses of that project) and switches the project to it. */
export async function saveProjectFlow(slug: string, projectId: string, steps: unknown): Promise<Result<ProjectFlowSettings>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const pid = projectOid(projectId);
    await writeProjectFlow(org._id, pid, user._id, steps);
    await announce(slug, org._id, user._id, pid);
    return loadProjectFlowSettings(org._id, pid);
  });
}

/** Drops a project's own flow; it inherits the org default again. */
export async function resetProjectFlow(slug: string, projectId: string): Promise<Result<ProjectFlowSettings>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    const pid = projectOid(projectId);
    await writeProjectFlowReset(org._id, pid);
    await announce(slug, org._id, user._id, pid);
    return loadProjectFlowSettings(org._id, pid);
  });
}

/** Inherit / Custom (copies the default onto the project's statuses when it has no flow yet) / Off. */
export async function setProjectFlowMode(slug: string, projectId: string, mode: FlowMode): Promise<Result<ProjectFlowSettings>> {
  return guard(async () => {
    const { org, user } = await requireOrg(slug, { admin: true });
    if (!isFlowMode(mode)) throw new UserError("Pick Inherit, Custom or Off.");
    const pid = projectOid(projectId);
    await writeProjectFlowMode(org._id, pid, user._id, mode);
    await announce(slug, org._id, user._id, pid);
    return loadProjectFlowSettings(org._id, pid);
  });
}
