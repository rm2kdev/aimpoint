// Runs once when the server starts (Next.js instrumentation hook).
export async function register() {
  // Billing on without Stripe config fails the server at startup with the missing var names (VEC-222).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { missingStripeEnv, billingConfigError } = await import("./lib/billing-core");
  const missing = missingStripeEnv(process.env);
  if (missing.length) throw new Error(billingConfigError(missing));
}
