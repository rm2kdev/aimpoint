"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "@/lib/session";
import { guard, type Result } from "@/lib/result";
import { publish } from "@/lib/realtime/server";
import { orgPath } from "@/lib/paths";
import {
  createProjectForm as createForm,
  deleteProjectForm as deleteForm,
  listProjectForms as listForms,
  updateProjectForm as updateForm,
  type FormActor,
  type FormInput,
  type FormPatch,
} from "@/lib/project-forms";
import type { ProjectForm } from "@/lib/types";

/* External forms (VEC-205): admin CRUD for a project's forms. The service refuses non-admins too. */

async function formActor(slug: string) {
  const ctx = await requireOrg(slug, { admin: true });
  const actor: FormActor = { orgId: ctx.org._id, userId: ctx.user._id, isAdmin: ctx.isAdmin };
  return { ctx, actor };
}

async function changed(slug: string, orgId: string, actorId: string, projectId: string) {
  // Other admins' open settings pages refresh their form list.
  await publish(orgId, { type: "org.changed", actorId, projectId });
  revalidatePath(orgPath(slug), "layout");
}

export async function listProjectForms(slug: string, projectId: string): Promise<Result<ProjectForm[]>> {
  return guard(async () => {
    const { actor } = await formActor(slug);
    return listForms(actor, projectId);
  });
}

export async function createProjectForm(slug: string, projectId: string, input: FormInput): Promise<Result<ProjectForm>> {
  return guard(async () => {
    const { ctx, actor } = await formActor(slug);
    const form = await createForm(actor, projectId, input);
    await changed(slug, ctx.org._id.toHexString(), ctx.user._id.toHexString(), form.projectId);
    return form;
  });
}

export async function updateProjectForm(slug: string, formId: string, patch: FormPatch): Promise<Result<ProjectForm>> {
  return guard(async () => {
    const { ctx, actor } = await formActor(slug);
    const form = await updateForm(actor, formId, patch);
    await changed(slug, ctx.org._id.toHexString(), ctx.user._id.toHexString(), form.projectId);
    return form;
  });
}

export async function deleteProjectForm(slug: string, formId: string): Promise<Result> {
  return guard(async () => {
    const { ctx, actor } = await formActor(slug);
    const projectId = await deleteForm(actor, formId);
    await changed(slug, ctx.org._id.toHexString(), ctx.user._id.toHexString(), projectId);
  });
}
