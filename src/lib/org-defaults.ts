import "server-only";
import type { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { DEFAULT_NEW_TASK_STAGE, isDefaultStage, type OrgDefaults } from "@/lib/types";

/** The org's defaults with presets filled in (VEC-128): an unset or invalid stored stage reads as Triage. */
export async function loadOrgDefaults(orgId: ObjectId): Promise<OrgDefaults> {
  const org = await (await cols()).orgs.findOne({ _id: orgId }, { projection: { defaults: 1 } });
  const stage = org?.defaults?.newTaskStage;
  return { newTaskStage: isDefaultStage(stage) ? stage : DEFAULT_NEW_TASK_STAGE };
}
