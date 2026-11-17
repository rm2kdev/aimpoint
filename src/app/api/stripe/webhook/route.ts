import { billingEnabled } from "@/lib/billing";
import { processEvent, verifyEvent } from "@/lib/stripe";

/**
 * Stripe webhook (VEC-223). 404 unless BILLING_ENABLED is on. Verifies the signature against
 * STRIPE_WEBHOOK_SECRET (400 on a missing/bad/stale one), then hands the event to `processEvent`,
 * which is idempotent per event id. 409 while another delivery of the same event is mid-flight and
 * 500 when handling fails, so Stripe retries both.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => new Response("Not found", { status: 404 });

export async function POST(req: Request) {
  if (!billingEnabled()) return notFound();
  const payload = await req.text();
  let event;
  try {
    event = verifyEvent(payload, req.headers.get("stripe-signature"));
  } catch (err) {
    return Response.json({ error: `Webhook signature verification failed: ${(err as Error).message}` }, { status: 400 });
  }
  try {
    const result = await processEvent(event);
    if (result.status === "busy") return Response.json({ received: false, status: "busy" }, { status: 409 });
    return Response.json({ received: true, ...result });
  } catch (err) {
    console.error(`[stripe] webhook ${event.type} ${event.id} failed`, err);
    return Response.json({ error: "Webhook handling failed." }, { status: 500 });
  }
}

export async function GET() {
  if (!billingEnabled()) return notFound();
  return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
}
