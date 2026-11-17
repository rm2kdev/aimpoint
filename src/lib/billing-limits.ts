/**
 * Plan enforcement helpers (VEC-224, reworked for paid-only hosting in VEC-262). There is no free tier and no count
 * limit any more: Pro and self-hosted include everything, and an org without a live subscription is locked
 * (lib/billing.ts assertOrgActive). This module adds the id-based lookups and the page-friendly forms of those checks,
 * so every path (server actions, REST `/api/v1`, MCP, public routes) gets the same answer. With billing off every
 * check passes.
 *
 * Locking is non-destructive: nothing here deletes or disables anything. A locked org keeps its members, bots,
 * projects and forms; they work again the moment it subscribes.
 */
import "server-only";
import type { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import { assertEntitlement, assertOrgActive, getEntitlements, isOrgActive, type Feature } from "@/lib/billing";
import type { OrgDoc } from "@/lib/types";

export { OrgLockedError, PlanLimitError } from "@/lib/billing";

type OrgLike = Pick<OrgDoc, "_id" | "billing">;

/** Throws PlanLimitError when the org's plan doesn't include `feature`. */
export function requireFeature(org: Pick<OrgDoc, "billing">, feature: Feature): void {
  assertEntitlement(org, feature);
}

async function orgBilling(orgId: ObjectId): Promise<OrgLike> {
  const c = await cols();
  const org = await c.orgs.findOne({ _id: orgId }, { projection: { _id: 1, billing: 1 } });
  return org ?? { _id: orgId };
}

/** The lock message when the plan lacks `feature`, else null (for pages that show it instead of throwing). */
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

/** assertOrgActive by id: throws OrgLockedError (REST 402) when the org has no live subscription. */
export async function assertOrgActiveById(orgId: ObjectId, opts: { isAdmin?: boolean } = {}): Promise<void> {
  assertOrgActive(await orgBilling(orgId), opts);
}

/** Whether the org is usable (Pro or self-hosted), by id (no throw). */
export async function orgActiveById(orgId: ObjectId): Promise<boolean> {
  return isOrgActive(await orgBilling(orgId));
}
