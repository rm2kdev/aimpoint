import "server-only";
import type { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import type { WatchMethod } from "@/lib/run-watch-core";
import type { BotMethod } from "@/lib/types";

/**
 * VEC-316: a work delivery (assigned / ready / a mention that hands the work back, and the follow-up itself) puts a
 * fresh watch on the bot's in_progress claim, so lib/unfinished-runs.ts can tell when that run is over without the
 * bot having called complete_task. A direct-API turn has already run when this is called (deliver() runs the whole
 * turn), so its run is recorded as ended right away. Claims without a watch are never followed up.
 */
const WATCHED: readonly BotMethod[] = ["claude-api", "openai-api", "hermes-api", "webhook"];

export async function armRunWatch(botId: ObjectId, taskId: ObjectId, method: BotMethod, opts: { followUp?: boolean } = {}) {
  if (!WATCHED.includes(method)) return;
  const c = await cols();
  const now = new Date();
  const direct = method === "claude-api" || method === "openai-api";
  await c.agentClaims.updateOne(
    { botId, taskId, state: "in_progress", kind: { $ne: "triage" } },
    { $set: { watch: { method: method as WatchMethod, at: now, endedAt: direct ? now : null, followUpAt: opts.followUp ? now : null } } },
  );
}
