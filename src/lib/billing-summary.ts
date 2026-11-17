/**
 * Server loader for the client billing summary (VEC-226; type in lib/billing-view.ts). Counts follow
 * lib/billing-limits.ts (VEC-224) so the UI disables exactly what the server would refuse.
 */
import "server-only";
import { cols } from "@/lib/db";
import { billingDebugActive, billingDebugProblem, billingOn, getEntitlements, getPlan } from "@/lib/billing";
import { billingDebugAvailable } from "@/lib/billing-mode";
import { PAST_DUE_GRACE_DAYS } from "@/lib/billing-core";
import { canceledEndDate, hasLiveSubscription } from "@/lib/stripe-sync";
import { UNLIMITED_SUMMARY, type BillingSummary } from "@/lib/billing-view";
import type { OrgDoc } from "@/lib/types";

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

export async function loadBillingSummary(org: Pick<OrgDoc, "_id" | "billing">): Promise<BillingSummary> {
  // Re-reads the VEC-240 debug toggle when stale, so a switch shows on the next page load / org.changed.
  if (!(await billingOn())) return { ...UNLIMITED_SUMMARY, debugAvailable: billingDebugAvailable() };
  const c = await cols();
  // members = billable seats (VEC-238, billableSeats in billing-core: human memberships, one each).
  const [members, pendingInvites, bots, projects, archivedProjects] = await Promise.all([
    c.memberships.countDocuments({ orgId: org._id }),
    c.invites.countDocuments({ orgId: org._id, acceptedAt: { $exists: false }, expiresAt: { $gt: new Date() } }),
    c.bots.countDocuments({ orgId: org._id }),
    c.projects.countDocuments({ orgId: org._id }),
    c.projects.countDocuments({ orgId: org._id, archivedAt: { $ne: null } }),
  ]);
  const b = org.billing ?? {};
  const plan = getPlan(org);
  const ent = getEntitlements(org);
  // A period end in the past on a live subscription is the previous subscription's (Checkout landed before its
  // subscription.created event): don't show it as the renewal date.
  const live = b.status === "active" || b.status === "trialing";
  const periodEnd = b.currentPeriodEnd && !(live && new Date(b.currentPeriodEnd).getTime() < Date.now()) ? b.currentPeriodEnd : null;
  const graceFrom = b.status === "past_due" ? (b.pastDueSince ?? b.currentPeriodEnd ?? null) : null;
  return {
    enabled: true,
    debug: billingDebugActive(),
    debugAvailable: billingDebugAvailable(),
    debugProblem: billingDebugProblem(),
    plan,
    status: b.status ?? null,
    currentPeriodEnd: iso(periodEnd),
    cancelAtPeriodEnd: !!b.cancelAtPeriodEnd,
    endedAt: iso(canceledEndDate(b, new Date())),
    pastDueSince: iso(b.pastDueSince),
    graceEndsAt: graceFrom ? new Date(new Date(graceFrom).getTime() + PAST_DUE_GRACE_DAYS * 86_400_000).toISOString() : null,
    hasCustomer: !!b.stripeCustomerId,
    liveSubscription: hasLiveSubscription(b),
    limits: { members: ent.maxMembers, bots: ent.maxBots, projects: ent.maxProjects, concurrentBotTasks: ent.maxConcurrentBotTasks },
    features: { analytics: ent.analytics, publicForms: ent.publicForms },
    usage: { members: members + pendingInvites, bots, projects, pendingInvites, archivedProjects },
    seats: members,
    subscribedSeats: typeof b.seats === "number" ? b.seats : null,
  };
}
