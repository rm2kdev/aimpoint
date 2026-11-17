import { timingSafeEqual } from "node:crypto";
import { sweepWaitReminders } from "@/lib/wait-reminders";

/**
 * Runs one wait-step reminder sweep (lib/wait-reminders.ts, VEC-182): tasks past their wait step's remindAfterDays
 * get their one `waiting` notification. The local server sweeps every minute by itself; on Vercel, schedule this as
 * a Cron Job (hourly or daily is plenty; Vercel sends `Authorization: Bearer <CRON_SECRET>`). Without CRON_SECRET
 * the route is off.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Not found" }, { status: 404 });
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json(await sweepWaitReminders());
}
