import { timingSafeEqual } from "node:crypto";
import { sweepWakes } from "@/lib/wake-queue";

/**
 * Runs one wake-up sweep (lib/wake-queue.ts): retries push wake-ups that are due and re-sends lost hand-offs.
 * The local server sweeps on a timer; on Vercel, schedule this as a Cron Job (`Authorization: Bearer $CRON_SECRET`,
 * which Vercel sends when CRON_SECRET is set). Without CRON_SECRET the route is off.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Not found" }, { status: 404 });
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await sweepWakes());
}
