import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { billingDebugActive, billingDebugProblem, billingEnabled } from "@/lib/billing";
import { debugStripeProblems, STRIPE_ENV_VARS, stripeKeyMode } from "@/lib/billing-core";
import { billingDebugAvailable, refreshBillingDebug } from "@/lib/billing-mode";
import { DebugSettings, type DebugView } from "@/components/settings/debug";

export const metadata = { title: "Debug · Settings" };
export const dynamic = "force-dynamic";

/**
 * Settings > Debug (VEC-240). Exists only on a self-hosted instance with AIMPOINT_DEBUG on, and only for org admins
 * (404 otherwise, so production users never see it). Reports the Stripe env by name and key mode, never values.
 */
export default async function DebugPage({ params }: PageProps<"/o/[org]/settings/debug">) {
  const { org } = await params;
  const { membership } = await requireOrgPage(org);
  if (!billingDebugAvailable() || membership.role !== "admin") notFound();
  const state = await refreshBillingDebug(true);
  let byName: string | null = null;
  if (state.by && ObjectId.isValid(state.by)) {
    const u = await (await cols()).users.findOne({ _id: new ObjectId(state.by) }, { projection: { name: 1 } });
    byName = u?.name ?? "Former member";
  }
  const view: DebugView = {
    toggle: { enabled: state.enabled, byName, at: state.at ? new Date(state.at).toISOString() : null },
    billingOn: billingEnabled(),
    debugActive: billingDebugActive(),
    problem: billingDebugProblem(),
    setupProblems: debugStripeProblems(process.env),
    env: STRIPE_ENV_VARS.map((name) => ({ name, set: !!(process.env[name] ?? "").trim() })),
    keyMode: (process.env.STRIPE_SECRET_KEY ?? "").trim() ? stripeKeyMode(process.env.STRIPE_SECRET_KEY) : null,
    apiBase: !!(process.env.STRIPE_API_BASE ?? "").trim(),
  };
  return <DebugSettings view={view} />;
}
