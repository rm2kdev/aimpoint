import "server-only";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { UserError } from "@/lib/result";
import type { Actor } from "@/lib/task-service";
import type { TaskDoc } from "@/lib/types";

/**
 * VEC-216: while a person has stopped a bot's work on a task (TaskDoc.stopped, VEC-215), that bot's writes on it are
 * refused, so a run that was already mid-turn can't carry on: complete_task, set_status, assign_task, update_task,
 * add_comment, release/advance, and create_task / update_task that link to it (depends_on, before/after). Checked
 * once in the MCP callTool (before a tool touches its claim) and again in the task service, so the REST API refuses
 * the same calls. Other bots and people are unaffected.
 *
 * add_comment stays open for one thing: answering a comment that @mentioned the bot after the stop (VEC-215 still
 * delivers those mentions, as questions).
 */

export class StoppedWorkError extends UserError {
  constructor(
    message: string,
    readonly stop: { task: string; by: string; at: string; kind: "assigned" | "triage" },
  ) {
    super(message);
  }
}

/** The refusal text. Starts "<Name> stopped your work on KEY; don't continue." so agents can't miss it. */
export function stoppedMessage(by: string, key: string, kind: "assigned" | "triage") {
  return `${by} stopped your ${kind === "triage" ? "triage of" : "work on"} ${key}; don't continue. Nothing was changed. Leave ${key} as it is and end your turn: while it's stopped Aimpoint refuses your changes to it (status, assignee, edits, comments, completing it, and tasks that link to it). You'll be handed it again, with a fresh wake-up, if they resume it. If someone @mentions you on it with a question, you can answer that with add_comment.`;
}

/** The first of `taskIds` that a person stopped `botId`'s work on, with the refusal; null when none is. */
export async function stopRefusal(botId: ObjectId, taskIds: ObjectId[], opts: { reply?: boolean } = {}): Promise<StoppedWorkError | null> {
  if (!taskIds.length) return null;
  const c = await cols();
  const stopped = await c.tasks.find({ _id: { $in: taskIds }, "stopped.botId": botId }, { projection: { stopped: 1, projectId: 1, number: 1 } }).toArray();
  for (const t of stopped as Pick<TaskDoc, "_id" | "stopped" | "projectId" | "number">[]) {
    const stop = t.stopped!;
    // A reply to a mention made after the stop is the one comment the bot may still post.
    if (opts.reply && (await c.botMentions.findOne({ botId, taskId: t._id, createdAt: { $gt: stop.at } }, { projection: { _id: 1 } }))) continue;
    const [user, project] = await Promise.all([
      c.users.findOne({ _id: stop.by }, { projection: { name: 1 } }),
      c.projects.findOne({ _id: t.projectId }, { projection: { key: 1 } }),
    ]);
    const by = user?.name ?? "A person";
    const key = `${project?.key ?? "?"}-${t.number}`;
    return new StoppedWorkError(stoppedMessage(by, key, stop.kind), { task: key, by, at: stop.at.toISOString(), kind: stop.kind });
  }
  return null;
}

/** Throws the refusal when `actor` is a bot whose work on one of `taskIds` is stopped. People are never refused. */
export async function assertNotStopped(actor: Actor, taskIds: (ObjectId | string | null | undefined)[], opts: { reply?: boolean } = {}) {
  if (!actor.isBot) return;
  const ids = taskIds.flatMap((id) => (id instanceof ObjectId ? [id] : typeof id === "string" && ObjectId.isValid(id) && /^[a-f0-9]{24}$/i.test(id) ? [new ObjectId(id)] : []));
  const err = await stopRefusal(actor.id, ids, opts);
  if (err) throw err;
}
