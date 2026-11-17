// No "server-only" and no path aliases (like project-statuses-migration.ts), so a one-off node script can
// run the same insert against the live database while the dev server's cached init has already run.
import { ObjectId, type Db } from "mongodb";
import type { FlowDoc } from "./types";
import { defaultFlowSteps } from "./flow-model";
import { flowStepsToDoc } from "./flow-convert";

export const DEFAULT_FLOW_MIGRATION = "2026-11-default-flow";

/** The seeded org default flow document (docs/flows.md section 4). */
export function defaultFlowDoc(orgId: ObjectId, at = new Date()): FlowDoc {
  return { _id: new ObjectId(), orgId, projectId: null, version: 1, steps: flowStepsToDoc(defaultFlowSteps()), updatedAt: at, updatedBy: null };
}

/** Inserts the default flow for every org that has none. Idempotent (unique {orgId, projectId}). Returns how many were added. */
export async function seedDefaultFlows(db: Db): Promise<number> {
  const flows = db.collection<FlowDoc>("flows");
  const orgIds = (await db.collection("orgs").find({}, { projection: { _id: 1 } }).toArray()).map((o) => o._id as ObjectId);
  let inserted = 0;
  for (const orgId of orgIds) {
    const doc = defaultFlowDoc(orgId);
    const { _id, ...rest } = doc;
    const res = await flows.updateOne({ orgId, projectId: null }, { $setOnInsert: { _id, ...rest } }, { upsert: true });
    inserted += res.upsertedCount;
  }
  return inserted;
}
