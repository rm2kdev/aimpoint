"use server";

import { revalidatePath } from "next/cache";
import { cols } from "@/lib/db";
import { debugBillingError, debugStripeProblems } from "@/lib/billing-core";
import { billingDebugAvailable, setBillingDebug } from "@/lib/billing-mode";
import { publish } from "@/lib/realtime/server";
import { guard, UserError, type Result } from "@/lib/result";
import { requireOrg } from "@/lib/session";
import { orgPath } from "@/lib/paths";

/**
 * Settings > Debug (VEC-240): an org admin on a self-hosted instance with AIMPOINT_DEBUG on switches test billing on
 * or off for the whole instance. Re-checks both conditions here, whatever the page showed. Turning it on needs a
 * complete Stripe test-mode setup (a live key is refused). Turning it off deletes nothing: orgs keep their billing data
 * and simply read as unlimited again.
 */
export async function setBillingDebugAction(slug: string, enabled: boolean): Promise<Result<{ enabled: boolean }>> {
  return guard(async () => {
    const { user } = await requireOrg(slug, { admin: true });
    if (!billingDebugAvailable())
      throw new UserError("Debug settings are off on this instance. They need AIMPOINT_DEBUG=1 on a self-hosted instance (BILLING_ENABLED unset).");
    if (typeof enabled !== "boolean") throw new UserError("Pick on or off.");
    if (enabled) {
      const problems = debugStripeProblems(process.env);
      if (problems.length) throw new UserError(debugBillingError(problems));
    }
    const state = await setBillingDebug(enabled, user._id.toHexString());
    // Instance-wide: every org's plan, limits and Billing tab change, so refresh every open tab.
    const c = await cols();
    const orgs = await c.orgs.find({}, { projection: { _id: 1 } }).toArray();
    await Promise.all(orgs.map((o) => publish(o._id.toHexString(), { type: "org.changed", actorId: user._id.toHexString() })));
    revalidatePath(orgPath(slug, "settings"), "layout");
    return { enabled: state.enabled };
  });
}
