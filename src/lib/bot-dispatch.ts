import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import { after } from "next/server";
import { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { unseal } from "@/lib/secrets";
import { isPush } from "@/lib/bot-connect";
import { buildTaskContext } from "@/lib/mcp/context";
import { publishWorking } from "@/lib/claims";
import { markStartedByBot, mentionResumesWork, resumeOnMention } from "@/lib/task-service";
import { dispatchWake, isQueuedWake } from "@/lib/wake-queue";
import { BOT_DELIVERY_HISTORY, isClosedCategory, type BotConnectionDoc, type BotDelivery, type BotDoc, type OrgDoc } from "@/lib/types";

/**
 * Push delivery: when a bot with a backend (Claude, OpenAI, Hermes, webhook) is assigned a task or
 * @mentioned, Vector calls that backend with the task, its description and the whole thread. The agent
 * then acts on the ticket through Vector's MCP tools. A successful delivery marks the work as picked up
 * (assignment) or delivered (mention), so check_for_work doesn't hand it out a second time.
 *
 * Task wake-ups (assigned, ready, close-out, mention) go through the wake queue (lib/wake-queue.ts): queued before
 * the first attempt, retried with backoff when a delivery fails, re-sent by a reconciler when a hand-off never got
 * that far, and shown as Stalled with a person notified when they still can't be delivered.
 */

export type WakeReason =
  | { kind: "assigned"; taskId: ObjectId; taskKey: string; title: string; by: string }
  | { kind: "mentioned"; taskId: ObjectId; commentId: ObjectId; taskKey: string; title: string; by: string }
  /** An assigned task's last dependency closed. `detail` says which, e.g. "WEB-1 is done". */
  | { kind: "ready"; taskId: ObjectId; taskKey: string; title: string; by: string; detail: string }
  /** A task landed in Triage and this bot (its role allows check_for_triage) now holds it to break down. */
  | { kind: "triage"; taskId: ObjectId; taskKey: string; title: string; by: string }
  /** A task this bot triaged is ready (its sub-tasks are closed: done or cancelled): summarise the work and close it out. */
  | { kind: "closeout"; taskId: ObjectId; taskKey: string; title: string; by: string; detail: string }
  | { kind: "test" };

interface WakeMessage {
  prompt: string;
  /** Full task context (same shape as the MCP tools return), when the wake-up is about a task. */
  task: unknown | null;
}

const TIMEOUT_MS = 15_000;
/** Direct API methods run the whole agent turn inside the request. */
const AGENT_TURN_MS = 240_000;

export const reasonLabel = (r: WakeReason) =>
  r.kind === "test"
    ? "test"
    : r.kind === "assigned"
      ? `assigned ${r.taskKey}`
      : r.kind === "ready"
        ? `${r.taskKey} ready`
        : r.kind === "triage"
          ? `triage ${r.taskKey}`
          : r.kind === "closeout"
            ? `close out ${r.taskKey}`
            : `mentioned on ${r.taskKey}`;

/** Schedules wake-ups after the response is sent. Never throws into the caller. */
export function wakeBots(orgId: ObjectId, botIds: ObjectId[], reason: WakeReason) {
  if (!botIds.length) return;
  const job = async () => {
    try {
      const c = await cols();
      const [org, bots] = await Promise.all([
        c.orgs.findOne({ _id: orgId }),
        c.bots.find({ orgId, _id: { $in: botIds }, "connection.method": { $exists: true } }).toArray(),
      ]);
      if (!org) return;
      const push = bots.filter((b) => b.connection && isPush(b.connection.method));
      await Promise.all(push.map((b) => (isQueuedWake(reason) ? dispatchWake(b, org, reason) : deliver(b, org, reason))));
    } catch (err) {
      console.error("[bot wake]", err);
    }
  };
  try {
    after(job);
  } catch {
    // Outside a request (scripts): run detached.
    void job();
  }
}

/**
 * A task landed in Triage: hand it to ONE connected (push) bot whose role switches on check_for_triage.
 * The triage claim is taken before delivery, so a polling triager can't get the same task; if the
 * delivery fails the claim is dropped and the next triage bot is tried. With no push triager, the task
 * waits for a polling bot's check_for_triage.
 */
export function wakeTriage(orgId: ObjectId, task: { taskId: ObjectId; taskKey: string; title: string; by: string; exclude?: ObjectId }) {
  const job = async () => {
    try {
      const c = await cols();
      const roles = await c.botRoles.find({ orgId, "tools.check_for_triage": true }, { projection: { _id: 1 } }).toArray();
      if (!roles.length) return;
      const [org, bots] = await Promise.all([
        c.orgs.findOne({ _id: orgId }),
        c.bots
          .find({ orgId, roleId: { $in: roles.map((r) => r._id) }, "connection.method": { $exists: true }, ...(task.exclude ? { _id: { $ne: task.exclude } } : {}) })
          .sort({ createdAt: 1 })
          .toArray(),
      ]);
      if (!org) return;
      const reason: WakeReason = { kind: "triage", taskId: task.taskId, taskKey: task.taskKey, title: task.title, by: task.by };
      for (const bot of bots.filter((b) => b.connection && isPush(b.connection.method))) {
        const claimId = new ObjectId();
        try {
          await c.agentClaims.insertOne({ _id: claimId, orgId, botId: bot._id, taskId: task.taskId, kind: "triage", state: "in_progress", claimedAt: new Date(), finishedAt: null });
        } catch (err) {
          const e = err as { code?: number; keyPattern?: Record<string, unknown> };
          if (e.code !== 11000) throw err;
          if (e.keyPattern && "kind" in e.keyPattern) return; // another bot is already triaging it
          continue; // this bot already holds another claim on the task (it's working on it as the assignee)
        }
        await publishWorking(orgId, bot._id, [task.taskId]);
        if ((await deliver(bot, org, reason)).ok) return;
        await c.agentClaims.deleteOne({ _id: claimId });
        await publishWorking(orgId, bot._id, [task.taskId]);
      }
    } catch (err) {
      console.error("[bot wake triage]", err);
    }
  };
  try {
    after(job);
  } catch {
    void job();
  }
}

/** A queued wake-up being delivered: its id (stable across retries) and which attempt this is (1 = first). */
export interface WakeAttempt {
  wakeId: ObjectId;
  attempt: number;
}

/**
 * Delivers one wake-up now and records the outcome on the bot (lastDelivery plus a capped history). Failures are
 * logged; retrying them is the wake queue's job.
 */
export async function deliver(bot: BotDoc, org: OrgDoc, reason: WakeReason, wake?: WakeAttempt): Promise<BotDelivery> {
  const conn = bot.connection!;
  let out: BotDelivery;
  const meta = wake ? { wakeId: wake.wakeId, attempt: wake.attempt } : {};
  try {
    const msg = await wakeMessage(bot, org, conn, reason);
    const res = await send(bot, org, conn, reason, msg, wake);
    if (res.ok) await markHandedOver(bot, org, reason);
    out = res.ok
      ? { at: new Date(), ok: true, reason: reasonLabel(reason), status: res.status, ...meta }
      : { at: new Date(), ok: false, reason: reasonLabel(reason), status: res.status, error: res.error, ...meta };
  } catch (err) {
    const e = err as Error;
    out = { at: new Date(), ok: false, reason: reasonLabel(reason), error: e.name === "TimeoutError" ? "Timed out after 15 seconds." : friendlyNetworkError(e), ...meta };
  }
  if (!out.ok) {
    const cause = (wake ? `attempt ${wake.attempt}: ` : "") + (out.error ?? `status ${out.status}`);
    console.error(`[bot wake] delivery failed: ${bot.name} (${conn.method}) ${out.reason}, ${cause}`);
  }
  await (await cols()).bots.updateOne(
    { _id: bot._id, "connection.method": conn.method },
    { $set: { "connection.lastDelivery": out }, $push: { "connection.deliveries": { $each: [out], $slice: -BOT_DELIVERY_HISTORY } } },
  );
  return out;
}

function friendlyNetworkError(e: Error) {
  const code = (e.cause as { code?: string } | undefined)?.code;
  if (code === "ECONNREFUSED") return "Connection refused. Is the agent running and listening on that address?";
  if (code === "ENOTFOUND") return "That host name doesn't resolve.";
  if (code === "ECONNRESET") return "The connection was reset.";
  if (code === "UND_ERR_CONNECT_TIMEOUT") return "Couldn't connect: no answer from that address (connect timed out).";
  return e.message || "Couldn't reach it.";
}

type SendResult = { ok: true; status: number } | { ok: false; status?: number; error: string };

/**
 * The task is now this bot's: same bookkeeping check_for_work does when it hands work out. Also used by the wake
 * queue when a retry finds the bot already acting on the task (an earlier attempt reached it after all).
 */
export async function markHandedOver(bot: BotDoc, org: OrgDoc, reason: WakeReason) {
  const c = await cols();
  if (reason.kind === "assigned" || reason.kind === "ready") {
    // Re-read: it may have been closed or archived between the wake-up and delivery. A closed task gets no
    // claim (check_for_work wouldn't hand it out either), so no working ring and nothing left in progress.
    const task = await c.tasks.findOne({ _id: reason.taskId }, { projection: { statusId: 1, archivedAt: 1 } });
    if (!task || task.archivedAt) return;
    const st = await c.statuses.findOne({ _id: task.statusId }, { projection: { category: 1 } });
    if (isClosedCategory(st?.category)) return;
    const res = await c.agentClaims.updateOne(
      { botId: bot._id, taskId: reason.taskId },
      { $setOnInsert: { _id: new ObjectId(), orgId: org._id, state: "in_progress", claimedAt: new Date(), finishedAt: null } },
      { upsert: true },
    );
    // Only a fresh claim starts work: the status follows it (Todo / In Review -> In Progress), and that
    // broadcast carries the claim too.
    if (res.upsertedCount && !(await markStartedByBot(org._id, bot._id, reason.taskId))) await publishWorking(org._id, bot._id, [reason.taskId]);
  } else if (reason.kind === "closeout") {
    // Delivered: check_for_work won't hand the close-out out again. Only the request this wake-up was for.
    await c.tasks.updateOne({ _id: reason.taskId, "closeout.botId": bot._id, "closeout.deliveredAt": null }, { $set: { "closeout.deliveredAt": new Date() } });
  } else if (reason.kind === "mentioned") {
    await c.botMentions.updateMany({ botId: bot._id, taskId: reason.taskId, deliveredAt: null }, { $set: { deliveredAt: new Date() } });
    // The assignee is back at work: claim in progress again, In Review -> In Progress, Stalled clears.
    await resumeOnMention(org._id, bot._id, reason.taskId);
  }
}

async function send(bot: BotDoc, org: OrgDoc, conn: BotConnectionDoc, reason: WakeReason, msg: WakeMessage, wake?: WakeAttempt): Promise<SendResult> {
  const secret = conn.secretSealed ? unseal(conn.secretSealed) : null;
  if (conn.method === "claude-api" || conn.method === "openai-api") {
    const vectorKey = conn.vectorKeySealed ? unseal(conn.vectorKeySealed) : null;
    if (!secret || !vectorKey || !conn.vectorUrl || !conn.model) return { ok: false, error: "The connection is missing its key or model. Run setup again." };
    const args = { bot, org, prompt: msg.prompt, apiKey: secret, vectorKey, mcpUrl: `${conn.vectorUrl}/api/mcp`, model: conn.model };
    return conn.method === "claude-api" ? claudeApi(args) : openaiApi(args);
  }
  if (!conn.url || !secret) return { ok: false, error: "The connection is missing its address or key. Run setup again." };
  switch (conn.method) {
    case "hermes-api":
      return hermesRun(bot, org, conn.url, secret, reason, msg, wake);
    case "webhook":
      return webhook(bot, org, conn.url, secret, reason, msg, wake);
    default:
      return { ok: false, error: "This connection method doesn't push." };
  }
}

/* ---------------- prompts ---------------- */

export const TRIAGE_STEPS = (key: string) =>
  [
    `1. Read ${key}: description, comments, the project's context and any images. get_workspace lists projects, statuses, and the people and bots you can assign (bots' descriptions say what each one does).`,
    `2. Work out the concrete tasks needed to deliver it, each small enough for one person or bot. If it's already that small, skip to step 4 and just route it.`,
    `3. create_task for each, in order, so earlier keys exist when later tasks name them in \`depends_on\`. Give each a clear title, a Markdown description with acceptance criteria, a priority and an assignee where the owner is clear. Tasks with nothing to wait for can run in parallel; an assignee is only handed a task once everything it depends on is done.`,
    `4. Turn ${key} into the umbrella: update_task with \`depends_on\` set to the new tasks (at least the last ones in each chain) and a description summarising the plan, so it becomes ready, and its assignee hears about it, when the work is finished.`,
    `5. complete_task on ${key} with a short comment listing the tasks you created and a \`status\` to move it out of Triage (e.g. Todo). That ends your triage of it. You stay its triager: when the last task it depends on is closed (done or cancelled), Vector calls you back (a close-out wake-up, or kind "closeout" on check_for_work) to summarise what was delivered and close ${key} out.`,
    `Until you call complete_task (or release_task to hand it back) you may edit ${key} like its creator: title, description, project, dependencies, status, assignee, priority, type and due date. Don't create new tasks in a Triage status.`,
  ].join("\n");

/** What a triager does when its umbrella's sub-tasks are all done (wake-up and check_for_work). */
export const CLOSEOUT_STEPS = (key: string) =>
  [
    `1. Read each task ${key} depends on (\`dependencies.dependsOn\`) with get_task: its status and its comments, which hold what was delivered and anything left open.`,
    `2. add_comment on ${key}: a short summary of what was delivered, task by task. Comments are plain text, so no Markdown (no **bold** or headings); a plain "- " list is fine.`,
    `3. complete_task on ${key} with \`status\` "Done". If any of those tasks was Cancelled, or its comments leave issues open, use "In Review" instead and say why in the comment so a person can decide.`,
    `As its triager you can only comment on ${key} and move it to a closing status; anything else needs its creator, its assignee or an admin.`,
  ].join("\n");

/**
 * Work wake-ups (assigned, ready, and a mention that hands the work back): how a bot keeps the ticket
 * posted while it works. Shared by the push prompt and check_for_work so the two can't drift.
 */
export const PROGRESS_HINT =
  "Keep the ticket posted while you work, with add_comment: right after you pick it up, a short plan of what you're going to do; then an update at each meaningful milestone (finished investigating, change made, checks running, blocker hit) and at least every 10 minutes or so of work, saying what's done and what's next. If the task has more than one step, post a short update as you finish each step, before starting the next, however quickly it went: there must be at least one update between the plan and your final comment, even when the task says to put the results in the final comment. Keep each update to a few lines of plain text (no Markdown) and don't post one for every tool call. If you're blocked or waiting on someone, say so straight away and @mention them (<@id>).";

/** Assigned / ready wake-ups: the pickup moves the task for the bot, so it only sets the final status. */
const STARTED_NOTE =
  "Vector moves it to In Progress for you as it's handed over (the task below may still show its earlier status), so don't set that yourself; finish with complete_task and Done, or In Review only when a named person must check something.";

/** Mention wake-ups to the task's assignee: the mention hands the work back, so the bot finishes it again. */
const RESUMED_NOTE =
  "You're its assignee, so this hands the work back to you: Vector moves it back to In Progress as this is delivered (the task below may still show In Review and Stalled). Reply to the comment and do what it asks, then finish with complete_task again: Done when the work meets its acceptance criteria (that releases the tasks waiting on it), or In Review only when a named person must check something, with a <@id> mention of them in the comment.";

const TOOLS_HINT =
  "Act on the ticket with the `vector` MCP tools: add_comment to reply or report progress (people only see what you post there), set_status to move it, assign_task to hand it on, update_task to edit it, and complete_task when your work on an assigned task is done. Moving a task to a done status releases the tasks that depend on it; In Review does not, so finish with Done when the work meets its acceptance criteria, and use In Review only when a person has to check something (@mention them). get_task re-reads it; get_workspace lists projects, statuses and people.";

/** What the backend receives: who did what, the full task and thread, and how to act on it. */
async function wakeMessage(bot: BotDoc, org: OrgDoc, conn: BotConnectionDoc, reason: WakeReason): Promise<WakeMessage> {
  if (reason.kind === "test") {
    return {
      prompt: `This is a test from Vector (${org.name}) to check that ${bot.name} is connected. Call get_workspace on the \`vector\` MCP server, then reply with one line naming the organisation it returns. Don't change anything.`,
      task: null,
    };
  }
  const c = await cols();
  const task = await c.tasks.findOne({ _id: reason.taskId, orgId: org._id });
  const project = task && (await c.projects.findOne({ _id: task.projectId }));
  let context: unknown = null;
  if (task && project) {
    const built = await buildTaskContext(task, project, {
      origin: conn.vectorUrl ?? "",
      org,
      bot,
      includeImages: false,
      highlight: reason.kind === "mentioned" ? [reason.commentId] : [],
    });
    context = built.data;
  }
  const head =
    reason.kind === "triage"
      ? `${reason.by} put ${reason.taskKey} "${reason.title}" in Triage in Vector (${org.name}). You're the triage bot for it: no other bot will be handed it. Break it down into the actual tasks needed to do the job and wire up their dependencies so the work happens in a logical order:\n\n${TRIAGE_STEPS(reason.taskKey)}`
      : reason.kind === "closeout"
      ? `${reason.taskKey} "${reason.title}" in Vector (${org.name}) is ready to close out: ${reason.detail}, so nothing it depends on is open any more. You triaged it, so wrapping it up is yours:\n\n${CLOSEOUT_STEPS(reason.taskKey)}`
      : reason.kind === "assigned"
      ? `${reason.by} assigned you ${reason.taskKey} "${reason.title}" in Vector (${org.name}). Do the work it asks for. ${STARTED_NOTE}\n\n${PROGRESS_HINT}`
      : reason.kind === "ready"
        ? `${reason.taskKey} "${reason.title}", assigned to you in Vector (${org.name}), is ready to work on: ${reason.detail}, so nothing it depends on is open any more. Do the work it asks for. Earlier tasks' comments may hold results you need (see \`dependencies\`; read them with get_task). ${STARTED_NOTE}\n\n${PROGRESS_HINT}`
        : `${reason.by} mentioned you in a comment on ${reason.taskKey} "${reason.title}" in Vector (${org.name}). The comment marked "new": true is the one that mentioned you. ${
            (await mentionResumesWork(org._id, bot._id, reason.taskId)) ? `${RESUMED_NOTE}\n\n${PROGRESS_HINT}` : "Reply to it."
          }`;
  const meta = project?.metadata?.filter((m) => m.key) ?? [];
  const projectBlock = meta.length
    ? `\n\nProject context for ${project!.key} (${project!.name}), set by the team. Follow it while you work:\n${meta.map((m) => `- ${m.key}: ${m.value.replace(/\n/g, "\n  ")}`).join("\n")}`
    : "";
  return {
    prompt: `${head}${projectBlock}\n\n${TOOLS_HINT}\n\nThe task, with its description and every comment:\n\n${JSON.stringify(context, null, 2)}`,
    task: context,
  };
}

export function wakeInstructions(bot: BotDoc, org: OrgDoc) {
  return `You are ${bot.name}, a bot in the Vector issue tracker for ${org.name}.${bot.description ? ` Your job: ${bot.description}` : ""} Vector messages you with the full task whenever you're assigned a task that's ready to work on (nothing it depends on is still open), when a task of yours becomes ready, when you're @mentioned, or (if you're a triage bot) when a task lands in Triage for you to break down and again when the tasks you broke it into are done, to close it out. Act on it through the \`vector\` MCP tools; people only see what you post there.`;
}

/* ---------------- Hermes Agent API ---------------- */

export const hermesBase = (url: string) => url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");

async function hermesRun(bot: BotDoc, org: OrgDoc, url: string, key: string, reason: WakeReason, msg: WakeMessage, wake?: WakeAttempt): Promise<SendResult> {
  const res = await fetch(`${hermesBase(url)}/v1/runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      // One key per queued wake-up, the same on every retry: if an attempt that timed out did start a run, Hermes
      // refuses the retry instead of starting a second one.
      "Idempotency-Key": `vector-${wake ? wake.wakeId.toHexString() : randomUUID()}`,
    },
    body: JSON.stringify({
      input: msg.prompt,
      instructions: wakeInstructions(bot, org),
      // One Hermes session per bot and task: a follow-up mention continues the same conversation.
      session_id: `vector-${bot._id.toHexString()}-${reason.kind === "test" ? "test" : reason.taskId.toHexString()}`,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok) return { ok: true, status: res.status };
  // 409 on a retry: Hermes already admitted a run under this wake-up's key (the earlier attempt got through).
  if (res.status === 409 && wake && wake.attempt > 1) return { ok: true, status: res.status };
  return { ok: false, status: res.status, error: await httpError(res, "Hermes") };
}

/** Checks the URL and key without starting a run. */
export async function hermesProbe(url: string, key: string): Promise<{ ok: true; model: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${hermesBase(url)}/v1/capabilities`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8_000) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: "Hermes rejected the key. Check API_SERVER_KEY in the .env and restart the gateway." };
    if (res.status === 404) return { ok: false, error: "That address answered, but not like a Hermes API server. Check the port (8642 by default)." };
    if (!res.ok) return { ok: false, error: await httpError(res, "Hermes") };
    const caps = (await res.json().catch(() => null)) as { model?: string; features?: { run_submission?: boolean } } | null;
    if (!caps?.features?.run_submission) return { ok: false, error: "This Hermes doesn't support runs. Update Hermes (hermes update) and try again." };
    return { ok: true, model: caps.model ?? "hermes-agent" };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.name === "TimeoutError" ? "No answer after 8 seconds. Vector has to be able to reach this address." : friendlyNetworkError(e) };
  }
}

/* ---------------- Direct model APIs (Vector runs the turn) ---------------- */

interface ApiArgs {
  bot: BotDoc;
  org: OrgDoc;
  apiKey: string;
  vectorKey: string;
  mcpUrl: string;
  model: string;
  prompt: string;
}

/** Messages API with the MCP connector: Anthropic calls Vector's MCP server itself. */
async function claudeApi(a: ApiArgs): Promise<SendResult> {
  const messages: { role: "user" | "assistant"; content: unknown }[] = [{ role: "user", content: a.prompt }];
  const deadline = AbortSignal.timeout(AGENT_TURN_MS);
  // Long tool loops come back as pause_turn; send the partial turn back to let Claude continue.
  for (let i = 0; i < 6; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": a.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "mcp-client-2025-11-20",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: a.model,
        max_tokens: 4096,
        system: wakeInstructions(a.bot, a.org),
        messages,
        mcp_servers: [{ type: "url", url: a.mcpUrl, name: "vector", authorization_token: a.vectorKey }],
        tools: [{ type: "mcp_toolset", mcp_server_name: "vector" }],
      }),
      signal: deadline,
    });
    if (!res.ok) return { ok: false, status: res.status, error: await httpError(res, "Anthropic") };
    const msg = (await res.json()) as { stop_reason?: string; content?: unknown[] };
    if (msg.stop_reason !== "pause_turn") return { ok: true, status: res.status };
    messages.push({ role: "assistant", content: msg.content ?? [] });
  }
  return { ok: true, status: 200 };
}

/** Responses API with a remote MCP tool: OpenAI calls Vector's MCP server itself. */
async function openaiApi(a: ApiArgs): Promise<SendResult> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${a.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: a.model,
      instructions: wakeInstructions(a.bot, a.org),
      input: a.prompt,
      tools: [{ type: "mcp", server_label: "vector", server_url: a.mcpUrl, authorization: a.vectorKey, require_approval: "never" }],
      store: false,
    }),
    signal: AbortSignal.timeout(AGENT_TURN_MS),
  });
  if (!res.ok) return { ok: false, status: res.status, error: await httpError(res, "OpenAI") };
  const out = (await res.json()) as { status?: string; error?: { message?: string } | null };
  if (out.status === "failed") return { ok: false, status: res.status, error: out.error?.message ?? "OpenAI reported the run failed." };
  return { ok: true, status: res.status };
}

/** Checks a provider key and model id without running anything. */
export async function providerProbe(provider: "anthropic" | "openai", apiKey: string, model: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const name = provider === "anthropic" ? "Anthropic" : "OpenAI";
  try {
    const res =
      provider === "anthropic"
        ? await fetch(`https://api.anthropic.com/v1/models/${encodeURIComponent(model)}`, {
            headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            signal: AbortSignal.timeout(8_000),
          })
        : await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(8_000) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: `${name} rejected that API key.` };
    if (res.status === 404) return { ok: false, error: `${name} doesn't know the model "${model}".` };
    if (!res.ok) return { ok: false, error: await httpError(res, name) };
    return { ok: true };
  } catch (err) {
    const e = err as Error;
    return { ok: false, error: e.name === "TimeoutError" ? `${name} didn't answer.` : friendlyNetworkError(e) };
  }
}

/* ---------------- Generic webhook ---------------- */

async function webhook(bot: BotDoc, org: OrgDoc, url: string, secret: string, reason: WakeReason, msg: WakeMessage, wake?: WakeAttempt): Promise<SendResult> {
  // Retries of one queued wake-up share the delivery id, so a receiver can drop a repeat of one it already handled.
  const id = wake ? `wake-${wake.wakeId.toHexString()}` : randomUUID();
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({
    type: reason.kind === "test" ? "ping" : `task.${reason.kind}`,
    id,
    bot: { id: bot._id.toHexString(), name: bot.name },
    org: { slug: org.slug, name: org.name },
    task: msg.task,
    by: reason.kind === "test" ? null : reason.by,
    prompt: msg.prompt,
    sentAt: new Date().toISOString(),
  });
  const sig = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Vector-Webhooks/1",
      "X-Vector-Event": reason.kind === "test" ? "ping" : `task.${reason.kind}`,
      "X-Vector-Delivery": id,
      "X-Vector-Timestamp": ts,
      "X-Vector-Signature": `sha256=${sig}`,
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok) return { ok: true, status: res.status };
  return { ok: false, status: res.status, error: await httpError(res, "The endpoint") };
}

async function httpError(res: Response, who: string) {
  let detail = "";
  try {
    const t = (await res.text()).slice(0, 300);
    const j = JSON.parse(t) as { error?: string | { message?: string } };
    detail = typeof j.error === "string" ? j.error : (j.error?.message ?? "");
  } catch {}
  return `${who} answered ${res.status}${detail ? `: ${detail}` : "."}`;
}
