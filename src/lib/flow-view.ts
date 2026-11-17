import "server-only";
import type { ObjectId } from "mongodb";
import { resolveOrgFlows } from "@/lib/flows";
import { flowIsActive } from "@/lib/flow-engine-core";
import type { ResolvedFlow } from "@/lib/flow-model";

/**
 * The flows the task UI shows (VEC-178): each project's resolved flow, keyed by project id, for the org layout's
 * OrgProvider. Only flows that name an owner or carry instructions on some step are sent: the seeded default
 * (keep / any triage bot owners, no text) says nothing the status doesn't, so tasks on it show no stepper, the
 * same reason the engine keeps it out of wake-ups and activity. Instructions and resolve issues stay on the
 * server (they're for the owner's hand-off and the editor), which keeps the layout payload small; a step with
 * instructions keeps a one-character marker so client-side `flowIsActive` answers the same as the server's. A flow edit
 * publishes org.changed, the layout refreshes, and the stepper follows.
 */
export async function loadClientFlows(orgId: ObjectId): Promise<Record<string, ResolvedFlow>> {
  const resolved = await resolveOrgFlows(orgId);
  const out: Record<string, ResolvedFlow> = {};
  for (const [projectId, flow] of resolved) {
    if (!flow || !flow.steps.some((s) => flowIsActive(flow, s))) continue;
    out[projectId] = {
      source: flow.source,
      version: flow.version,
      steps: flow.steps.map((s) => ({ ...s, instructions: s.instructions.trim() ? "1" : "", issues: [] })),
      skipped: [],
      hasIssues: false,
    };
  }
  return out;
}
