/**
 * Free plan enforcement (VEC-224). The plan rules and messages live in billing-core / billing; this module counts
 * what an org has and refuses the write that would take it past its plan, so every path (server actions, REST
 * `/api/v1`, MCP, public routes) gets the same answer. With billing off every check passes.
 *
 * Counting rules (kept the same everywhere):
 * - People = memberships plus pending invites (not accepted, not expired), so a Free org can't queue invites.
 * - Projects = every project, archived ones included: archiving keeps the project's data, so it can't be used to
 *   make room for another one.
 * - Bots = every bot of the org.
 *
 * Downgrades are non-destructive: nothing here deletes or disables anything. An org over its limit after
 * cancelling keeps its members, bots, projects and forms but can't add more until it's within the limit or Pro.
 * Analytics and public forms are refused while on Free; the forms themselves stay and work again on Pro.
 */
import "server-only";
import type { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { assertEntitlement, assertWithinLimit, getEntitlements, type Feature, type LimitKind } from "@/lib/billing";
import type { OrgDoc } from "@/lib/types";

/** A refusal because of the org's plan: REST answers 402, the UI and MCP show the message (it says how to upgrade). */
export class PlanLimitError extends UserError {
  readonly upgrade = true;
  constructor(message: string) {
    super(message);
    this.name = "PlanLimitError";
  }
}

type OrgLike = Pick<OrgDoc, "_id" | "billing">;

function rethrow(fn: () => void) {
  try {
    fn();
  } catch (err) {
    if (err instanceof UserError && !(err instanceof PlanLimitError)) throw new PlanLimitError(err.message);
    throw err;
  }
}

function limitCheck(org: OrgLike, kind: LimitKind, current: number) {
  rethrow(() => assertWithinLimit(org, kind, current));
}

/** Throws PlanLimitError when the org's plan doesn't include `feature`. */
export function requireFeature(org: Pick<OrgDoc, "billing">, feature: Feature): void {
  rethrow(() => assertEntitlement(org, feature));
}

async function orgBilling(orgId: ObjectId): Promise<OrgLike> {
  const c = await cols();
  const org = await c.orgs.findOne({ _id: orgId }, { projection: { _id: 1, billing: 1 } });
  return org ?? { _id: orgId };
}

/** The upgrade message when the plan lacks `feature`, else null (for pages that show it instead of throwing). */
export function featureLockMessage(org: Pick<OrgDoc, "billing">, feature: Feature): string | null {
  try {
    assertEntitlement(org, feature);
    return null;
  } catch (err) {
    if (err instanceof UserError) return err.message;
    throw err;
  }
}

/** Same as requireFeature, loading the org's billing state by id (for paths that only hold the org id). */
export async function requireFeatureById(orgId: ObjectId, feature: Feature): Promise<void> {
  requireFeature(await orgBilling(orgId), feature);
}

/** Whether the org's plan includes `feature`, by id (no throw). */
export async function hasFeature(orgId: ObjectId, feature: Feature): Promise<boolean> {
  return getEntitlements(await orgBilling(orgId))[feature];
}

const unlimited = (org: OrgLike, kind: "maxMembers" | "maxBots" | "maxProjects") => getEntitlements(org)[kind] === null;

/** People: members + pending invites. `exceptEmail` = an invite being re-sent to the same address (it replaces itself). */
export async function assertRoomForPerson(org: OrgLike, opts: { exceptEmail?: string; accepting?: boolean } = {}): Promise<void> {
  if (unlimited(org, "maxMembers")) return;
  const c = await cols();
  const members = await c.memberships.countDocuments({ orgId: org._id });
  // Accepting turns its own (already counted) invite into a membership, so only memberships matter then: an
  // invite sent before a downgrade can't be redeemed while the org is at or over its limit.
  const pending = opts.accepting
    ? 0
    : await c.invites.countDocuments({
        orgId: org._id,
        acceptedAt: { $exists: false },
        expiresAt: { $gt: new Date() },
        ...(opts.exceptEmail ? { email: { $ne: opts.exceptEmail } } : {}),
      });
  limitCheck(org, "members", members + pending);
}

export async function assertRoomForBot(org: OrgLike): Promise<void> {
  if (unlimited(org, "maxBots")) return;
  const c = await cols();
  limitCheck(org, "bots", await c.bots.countDocuments({ orgId: org._id }));
}

/** Archived projects count (see the module note). */
export async function assertRoomForProject(org: OrgLike): Promise<void> {
  if (unlimited(org, "maxProjects")) return;
  const c = await cols();
  limitCheck(org, "projects", await c.projects.countDocuments({ orgId: org._id }));
}
