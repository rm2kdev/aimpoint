"use server";

import { revalidatePath } from "next/cache";
import { currentUser, requireOrg } from "@/lib/session";
import { guard, UserError, type Result } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { orgPath } from "@/lib/paths";
import {
  getProjectPublicAccess as getAccess,
  listMyPublicSubmissions as listMine,
  setProjectPublicAccess as setAccess,
  submitPublicTicket as submitTicket,
  type PublicAccessPatch,
  type PublicSettingsActor,
  type PublicSubmission,
  type PublicSubmitResult,
} from "@/lib/project-public";
import type { ProjectPublicAccess, PublicTask } from "@/lib/types";

/* Public projects (VEC-255). Settings are admin-only (the service refuses non-admins too); submitting needs any signed-in account. */

async function settingsActor(slug: string) {
  const ctx = await requireOrg(slug, { admin: true });
  const actor: PublicSettingsActor = { orgId: ctx.org._id, userId: ctx.user._id, isAdmin: ctx.isAdmin };
  return { ctx, actor };
}

export async function getProjectPublicAccess(slug: string, projectId: string): Promise<Result<ProjectPublicAccess>> {
  return guard(async () => {
    const { actor } = await settingsActor(slug);
    return getAccess(actor, projectId);
  });
}

export async function setProjectPublicAccess(slug: string, projectId: string, patch: PublicAccessPatch): Promise<Result<ProjectPublicAccess>> {
  return guard(async () => {
    const { ctx, actor } = await settingsActor(slug);
    const access = await setAccess(actor, projectId, patch ?? {});
    // Other admins' open settings pages refresh.
    await publish(ctx.org._id.toHexString(), { type: "org.changed", actorId: ctx.user._id.toHexString(), projectId: access.projectId });
    revalidatePath(orgPath(slug), "layout");
    return access;
  });
}

/** Files a ticket into a public project as the signed-in account. The answer carries only the new key or a short error. */
export async function submitPublicTicket(slug: string, key: string, input: PublicSubmission): Promise<PublicSubmitResult> {
  try {
    return await submitTicket(await currentUser(), slug, key, input ?? { title: "" });
  } catch (err) {
    console.error("[public submit]", err);
    return { ok: false, status: 400, error: "Something went wrong. Try again." };
  }
}

/** The signed-in account's own submissions to a public project. */
export async function listMyPublicSubmissions(slug: string, key: string): Promise<Result<PublicTask[]>> {
  return guard(async () => {
    const user = await currentUser();
    if (!user) throw new UserError("Sign in to see your tickets.");
    const list = await listMine(user, slug, key);
    if (!list) throw new UserError("This project doesn't exist or isn't public.");
    return list;
  });
}
