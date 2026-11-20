import "server-only";
import { ObjectId } from "mongodb";
import { nanoid } from "nanoid";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { loadStatuses, requireProjectStatus } from "@/lib/statuses";
import { requireFeatureById } from "@/lib/billing-limits";
import { resolveFormOptions, type FormOptions } from "@/lib/form-upload-core";
import { checkHideDescription, cleanEmailHelp, cleanFormFields, type FormField } from "@/lib/form-fields-core";
import {
  FORM_DESTINATION_STAGES,
  TASK_TYPES,
  isFormDestinationStage,
  isTaskType,
  type FormTypeMode,
  type ProjectForm,
  type ProjectFormDoc,
  type StatusCategory,
  type StatusDoc,
  type TaskType,
} from "@/lib/types";

/**
 * External forms (VEC-204/205): admin CRUD per project, plus the status/project hooks that keep every form pointing
 * at a valid status of its own project. Submissions go through createTaskFromForm in task-service.
 */

/** Who manages forms: a signed-in member of the org. Only admins may. */
export interface FormActor {
  orgId: ObjectId;
  userId: ObjectId;
  isAdmin: boolean;
}

export const FORM_NAME_MAX = 80;
export const FORM_INTRO_MAX = 2000;
const STAGE_WORDS = "Backlog, Triage or a not-started status";

export interface FormInput {
  name: string;
  destinationStatusId: string;
  enabled?: boolean;
  typeMode?: FormTypeMode;
  /** Fixed type (typeMode fixed) or the preselected one (typeMode choose). Default issue. */
  type?: TaskType;
  /** typeMode choose: the types a submitter may pick. */
  allowedTypes?: TaskType[];
  intro?: string | null;
  /** VEC-233: rich text description (default false). */
  richText?: boolean;
  /** VEC-233: submitters may add images; needs richText (default false). */
  allowImages?: boolean;
  /** TPA-399: extra fields in form order (each: id to keep, label, help, kind short|long|screenshot, required). */
  fields?: unknown[] | null;
  /** TPA-399: note under the optional Email field. */
  emailHelp?: string | null;
  /** TPA-399: leave out the generic description box (needs a text field). */
  hideDescription?: boolean;
}
export type FormPatch = Partial<FormInput>;

export function toProjectForm(f: ProjectFormDoc): ProjectForm {
  return {
    id: f._id.toHexString(),
    projectId: f.projectId.toHexString(),
    name: f.name,
    publicId: f.publicId,
    enabled: f.enabled,
    disabledReason: f.disabledReason ?? null,
    destinationStatusId: f.destinationStatusId.toHexString(),
    typeMode: f.typeMode,
    type: f.type,
    allowedTypes: [...f.allowedTypes],
    intro: f.intro ?? null,
    ...formOptions(f),
    ...formExtras(f),
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

function assertAdmin(actor: FormActor) {
  if (!actor.isAdmin) throw new UserError("Only admins can manage a project's external forms.");
}

const oid = (id: string, what: string) => {
  if (!ObjectId.isValid(id)) throw new UserError(`Unknown ${what}.`);
  return new ObjectId(id);
};

async function requireProject(orgId: ObjectId, projectId: string) {
  const c = await cols();
  const project = await c.projects.findOne({ _id: oid(projectId, "project"), orgId }, { projection: { name: 1, key: 1, archivedAt: 1 } });
  if (!project) throw new UserError("That project no longer exists.");
  return project;
}

/** A status of the form's own project, in a stage a form may file into. UserError otherwise. */
export async function requireFormDestination(orgId: ObjectId, projectId: ObjectId, statusId: string): Promise<StatusDoc> {
  if (!statusId) throw new UserError(`Pick where submissions go: ${STAGE_WORDS}.`);
  const status = await requireProjectStatus(orgId, projectId, String(statusId));
  if (!isFormDestinationStage(status.category)) {
    throw new UserError(`Forms can only file into ${STAGE_WORDS}, not "${status.name}".`);
  }
  return status;
}

function cleanName(v: unknown) {
  const name = String(v ?? "").trim();
  if (!name) throw new UserError("Name the form.");
  if (name.length > FORM_NAME_MAX) throw new UserError(`Keep form names under ${FORM_NAME_MAX} characters.`);
  return name;
}

function cleanIntro(v: unknown) {
  if (v === null || v === undefined) return null;
  const intro = String(v).replace(/\r\n/g, "\n").trim();
  if (intro.length > FORM_INTRO_MAX) throw new UserError(`Keep the intro under ${FORM_INTRO_MAX.toLocaleString()} characters.`);
  return intro || null;
}

/** The form's editor options, with forms saved before VEC-233 reading as plain text without images. */
export function formOptions(f: Pick<ProjectFormDoc, "richText" | "allowImages">): FormOptions {
  const richText = f.richText === true;
  return { richText, allowImages: richText && f.allowImages === true };
}

/** TPA-399 settings with defaults for forms saved before them: no fields, no email note, description shown. */
export function formExtras(f: Pick<ProjectFormDoc, "fields" | "emailHelp" | "hideDescription">): { fields: FormField[]; emailHelp: string | null; hideDescription: boolean } {
  const fields = Array.isArray(f.fields) ? f.fields.map((x) => ({ ...x, help: x.help ?? null, required: x.required === true })) : [];
  return { fields, emailHelp: f.emailHelp ?? null, hideDescription: f.hideDescription === true && fields.some((x) => x.kind !== "screenshot") };
}

/** Validates fields/emailHelp/hideDescription together; ones left out keep `kept`. UserError on bad input. */
function cleanExtras(patch: Pick<FormInput, "fields" | "emailHelp" | "hideDescription">, kept?: ReturnType<typeof formExtras>) {
  const fields = patch.fields !== undefined ? cleanFormFields(patch.fields) : (kept?.fields ?? []);
  if (typeof fields === "string") throw new UserError(fields);
  const emailHelp = patch.emailHelp !== undefined ? cleanEmailHelp(patch.emailHelp) : (kept?.emailHelp ?? null);
  if (emailHelp && typeof emailHelp === "object") throw new UserError(emailHelp.error);
  if (patch.hideDescription !== undefined && typeof patch.hideDescription !== "boolean") throw new UserError("`hideDescription` is true or false.");
  const hideDescription = patch.hideDescription ?? kept?.hideDescription ?? false;
  const bad = checkHideDescription(hideDescription, fields);
  if (bad) throw new UserError(patch.hideDescription === undefined ? "The description box is hidden, so keep at least one text field (or show the description box again)." : bad);
  return { fields, emailHelp, hideDescription };
}

/** Validates richText/allowImages like cleanTypes: fields left out keep `kept`; images need rich text. */
function cleanOptions(richText: unknown, allowImages: unknown, kept?: FormOptions): FormOptions {
  const r = resolveFormOptions({ richText, allowImages }, kept);
  if (typeof r === "string") throw new UserError(r);
  return r;
}

const TYPE_WORDS = TASK_TYPES.join(", ");

/** Validates the type settings as a whole: fixed = one known type; choose = 2+ known types, the default among them. */
function cleanTypes(mode: unknown, type: unknown, allowed: unknown, keptType?: TaskType): Pick<ProjectFormDoc, "typeMode" | "type" | "allowedTypes"> {
  if (mode !== "fixed" && mode !== "choose") throw new UserError('The type setting is "fixed" or "choose".');
  if (type !== undefined && !isTaskType(type)) throw new UserError(`Unknown task type "${String(type)}". Types are: ${TYPE_WORDS}.`);
  if (mode === "fixed") return { typeMode: "fixed", type: (type as TaskType | undefined) ?? keptType ?? "issue", allowedTypes: [] };
  if (!Array.isArray(allowed)) throw new UserError("Pick the types a submitter can choose from.");
  const bad = allowed.filter((t) => !isTaskType(t));
  if (bad.length) throw new UserError(`Unknown task type "${String(bad[0])}". Types are: ${TYPE_WORDS}.`);
  // Keep the canonical TASK_TYPES order, once each.
  const set = new Set(allowed as TaskType[]);
  const list = TASK_TYPES.filter((t) => set.has(t));
  if (list.length < 2) throw new UserError("Letting the submitter choose needs at least two types. Use a fixed type for one.");
  // An unchanged earlier type that isn't in the new list falls back to the first allowed one; an explicit one must be in it.
  const preset = (type as TaskType | undefined) ?? (keptType && list.includes(keptType) ? keptType : list[0]);
  if (!list.includes(preset)) throw new UserError(`The preselected type must be one of the types the submitter can choose (${list.join(", ")}).`);
  return { typeMode: "choose", type: preset, allowedTypes: list };
}

export async function listProjectForms(actor: FormActor, projectId: string): Promise<ProjectForm[]> {
  assertAdmin(actor);
  const project = await requireProject(actor.orgId, projectId);
  const c = await cols();
  const list = await c.projectForms.find({ orgId: actor.orgId, projectId: project._id }).sort({ createdAt: 1 }).toArray();
  return list.map(toProjectForm);
}

export async function createProjectForm(actor: FormActor, projectId: string, input: FormInput): Promise<ProjectForm> {
  assertAdmin(actor);
  // An unpaid (locked) org has no public forms (VEC-224/262). Existing forms are kept (and stay editable); their links say unavailable.
  await requireFeatureById(actor.orgId, "publicForms");
  const project = await requireProject(actor.orgId, projectId);
  if (project.archivedAt) throw new UserError(`${project.name} (${project.key}) is archived. Restore it before adding forms.`);
  const status = await requireFormDestination(actor.orgId, project._id, input.destinationStatusId);
  const types = cleanTypes(input.typeMode ?? "fixed", input.type, input.allowedTypes);
  const options = cleanOptions(input.richText, input.allowImages);
  const extras = cleanExtras(input);
  const now = new Date();
  const doc: ProjectFormDoc = {
    _id: new ObjectId(),
    orgId: actor.orgId,
    projectId: project._id,
    name: cleanName(input.name),
    publicId: nanoid(24),
    enabled: input.enabled ?? true,
    disabledReason: null,
    destinationStatusId: status._id,
    ...types,
    intro: cleanIntro(input.intro),
    ...options,
    ...extras,
    createdBy: actor.userId,
    createdAt: now,
    updatedAt: now,
  };
  const c = await cols();
  await c.projectForms.insertOne(doc);
  return toProjectForm(doc);
}

async function ownForm(orgId: ObjectId, formId: string) {
  const c = await cols();
  const form = await c.projectForms.findOne({ _id: oid(formId, "form"), orgId });
  if (!form) throw new UserError("This form no longer exists.");
  return form;
}

export async function updateProjectForm(actor: FormActor, formId: string, patch: FormPatch): Promise<ProjectForm> {
  assertAdmin(actor);
  const form = await ownForm(actor.orgId, formId);
  const set: Partial<ProjectFormDoc> = {};
  if (patch.name !== undefined) set.name = cleanName(patch.name);
  if (patch.intro !== undefined) set.intro = cleanIntro(patch.intro);
  if (patch.destinationStatusId !== undefined) set.destinationStatusId = (await requireFormDestination(actor.orgId, form.projectId, patch.destinationStatusId))._id;
  if (patch.typeMode !== undefined || patch.type !== undefined || patch.allowedTypes !== undefined) {
    // Fields left out keep their saved values (a fixed form switching to choose has no list yet, so it must send one).
    Object.assign(set, cleanTypes(patch.typeMode ?? form.typeMode, patch.type, patch.allowedTypes ?? form.allowedTypes, form.type));
  }
  if (patch.richText !== undefined || patch.allowImages !== undefined) {
    Object.assign(set, cleanOptions(patch.richText, patch.allowImages, formOptions(form)));
  }
  if (patch.fields !== undefined || patch.emailHelp !== undefined || patch.hideDescription !== undefined) {
    Object.assign(set, cleanExtras(patch, formExtras(form)));
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new UserError("`enabled` is true or false.");
    set.enabled = patch.enabled;
    if (patch.enabled) {
      // Re-enabling a form Aimpoint switched off: its destination must be valid again (the admin may pick one in the same save).
      if (!set.destinationStatusId) await requireFormDestination(actor.orgId, form.projectId, form.destinationStatusId.toHexString());
      set.disabledReason = null;
    }
  }
  if (!Object.keys(set).length) return toProjectForm(form);
  set.updatedAt = new Date();
  const c = await cols();
  const after = await c.projectForms.findOneAndUpdate({ _id: form._id, orgId: actor.orgId }, { $set: set }, { returnDocument: "after" });
  if (!after) throw new UserError("This form no longer exists.");
  return toProjectForm(after);
}

/** Deletes the form; returns its project's id. Tasks it created keep their `source`. */
export async function deleteProjectForm(actor: FormActor, formId: string): Promise<string> {
  assertAdmin(actor);
  const form = await ownForm(actor.orgId, formId);
  const c = await cols();
  await c.projectForms.deleteOne({ _id: form._id, orgId: actor.orgId });
  return form.projectId.toHexString();
}

/** A form taking submissions, with its editor options and TPA-399 extras resolved. */
export type OpenForm = ProjectFormDoc & FormOptions & ReturnType<typeof formExtras>;

/**
 * The form behind a public link, if it takes submissions: enabled, its project still exists and isn't archived.
 * Null otherwise (the public route answers 404 either way, so nothing about why leaks). `richText`/`allowImages`
 * are always filled in (false for forms saved before VEC-233).
 */
export async function findOpenForm(publicId: string): Promise<OpenForm | null> {
  if (typeof publicId !== "string" || !/^[\w-]{10,64}$/.test(publicId)) return null;
  const c = await cols();
  const form = await c.projectForms.findOne({ publicId, enabled: true });
  if (!form) return null;
  const project = await c.projects.findOne({ _id: form.projectId, orgId: form.orgId }, { projection: { archivedAt: 1 } });
  return project && !project.archivedAt ? { ...form, ...formOptions(form), ...formExtras(form) } : null;
}

/* ---------------- keeping destinations valid ---------------- */

/** The project's first status (workflow order) of `stage`, other than `except`, when the stage is one a form may use. */
function firstOfStage(list: StatusDoc[], stage: StatusCategory, except?: ObjectId) {
  if (!isFormDestinationStage(stage)) return undefined;
  return list.find((s) => s.category === stage && !(except && s._id.equals(except)));
}

/** Any allowed status of the project (backlog, then triage, then not started), for a form being switched off. */
function anyDestination(list: StatusDoc[], except?: ObjectId) {
  for (const stage of FORM_DESTINATION_STAGES) {
    const hit = firstOfStage(list, stage, except);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Re-point (or, failing that, switch off) every form of `projectId` whose destination is `statusId`.
 * `remap` = keep the form running there; `fallback` = park it there disabled with `reason`.
 */
async function moveForms(orgId: ObjectId, projectId: ObjectId, statusId: ObjectId, remap: StatusDoc | undefined, fallback: StatusDoc | undefined, reason: string) {
  const c = await cols();
  const now = new Date();
  const filter = { orgId, projectId, destinationStatusId: statusId };
  if (remap) return (await c.projectForms.updateMany(filter, { $set: { destinationStatusId: remap._id, updatedAt: now } })).modifiedCount;
  // A project always has a triage and a not-started status (assertRequiredStages), so a fallback exists in practice.
  if (!fallback) return (await c.projectForms.deleteMany(filter)).deletedCount;
  return (await c.projectForms.updateMany(filter, { $set: { destinationStatusId: fallback._id, enabled: false, disabledReason: reason, updatedAt: now } })).modifiedCount;
}

/**
 * A status of `projectId` is being deleted and its tasks move to `moveTo`. Forms filing into it follow the tasks
 * when `moveTo` is an allowed stage, else go to the project's first other status of the deleted one's stage, else
 * are switched off (pointing at an allowed status, never a dangling id). Call before or after the delete; the
 * project's statuses are re-read without `removed`.
 */
export async function formsStatusDeleted(orgId: ObjectId, projectId: ObjectId, removed: StatusDoc, moveTo: StatusDoc): Promise<number> {
  const list = (await loadStatuses(orgId, projectId)).filter((s) => !s._id.equals(removed._id));
  const remap = isFormDestinationStage(moveTo.category) && !moveTo._id.equals(removed._id) ? moveTo : firstOfStage(list, removed.category);
  return moveForms(orgId, projectId, removed._id, remap, anyDestination(list), `Its status "${removed.name}" was deleted. Pick where submissions go, then switch it back on.`);
}

/**
 * A status of `projectId` changed stage. When it left the allowed stages, forms filing into it move to the
 * project's first other status of its old stage, else are switched off. Call after the status update.
 */
export async function formsStatusStageChanged(orgId: ObjectId, projectId: ObjectId, status: { _id: ObjectId; name: string }, from: StatusCategory, to: StatusCategory): Promise<number> {
  if (from === to || isFormDestinationStage(to)) return 0;
  const list = await loadStatuses(orgId, projectId);
  return moveForms(orgId, projectId, status._id, firstOfStage(list, from, status._id), anyDestination(list, status._id), `Its status "${status.name}" no longer takes new work. Pick where submissions go, then switch it back on.`);
}

/** The project is being deleted: its forms go with it. */
export async function deleteProjectForms(orgId: ObjectId, projectId: ObjectId): Promise<number> {
  return (await (await cols()).projectForms.deleteMany({ orgId, projectId })).deletedCount;
}
