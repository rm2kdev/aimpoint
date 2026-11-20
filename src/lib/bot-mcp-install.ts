import "server-only";
import { randomUUID } from "node:crypto";
import { after } from "next/server";
import type { ObjectId } from "mongodb";
import { cols } from "@/lib/db";
import { unseal } from "@/lib/secrets";
import { friendlyNetworkError, hermesBase, hermesProbe, httpError } from "@/lib/bot-dispatch";
import type { BotDoc, BotMcpInstall, BotMcpInstallDoc, OrgDoc } from "@/lib/types";
import { LEGACY_MCP_SERVER_NAME, MCP_SERVER_NAME, type McpServerName } from "@/lib/mcp-name";

/**
 * "Install Aimpoint's MCP server" for a Hermes connection (VEC-169, recipe from the VEC-168 spike).
 *
 * 1. Install run: POST /v1/runs with a prompt that saves the bot key to the profile's .env, runs
 *    `hermes mcp add aimpoint` and `hermes mcp test aimpoint` (then drops the pre-rename `vector` entry, VEC-198), and
 *    answers `AIMPOINT_MCP_INSTALL: ok|failed`.
 * 2. Hermes never sees new MCP tools in the run that added them: the gateway picks the server up on its housekeeping
 *    reconcile, 40-80 s later. So Aimpoint waits, then sends check runs that call get_workspace (CHECK_AT_MS).
 * 3. Installed = the bot called Aimpoint (lastUsedAt moved) after the check run started. The run's text alone is model
 *    output, and the install run's own `mcp test` also calls Aimpoint, so neither counts.
 *
 * The state lives on the bot (`mcpInstall`) and is advanced one step at a time under a lease, by an after() driver and
 * by every wizard poll, so it finishes even if the wizard is closed or the driver is cut off (serverless).
 * The key only ever travels in the install run's input: it is never stored, logged or returned here.
 */

/** Longest an install run may take before Aimpoint stops it. Spike: 13-47 s, wrong key 42 s. */
const INSTALL_RUN_MS = 180_000;
/**
 * When each check run is due, counted from the install finishing. The gateway's reconcile loads a new server 38-78 s
 * after the install. A reinstall over a `vector` server Hermes had parked (its old key stopped working and 5 reconnects
 * failed) leaves config.yaml unchanged, so it only heals on the parked server's self-probe, every 300 s: the later
 * checks cover that.
 */
const CHECK_AT_MS = [60_000, 120_000, 180_000, 300_000, 390_000];
const MAX_CHECKS = CHECK_AT_MS.length;
/** At least this long between one check run finishing and the next starting. */
const MIN_CHECK_GAP_MS = 20_000;
const CHECK_RUN_MS = 120_000;
const LEASE_MS = 30_000;
const DRIVER_TICK_MS = 3_000;
/** The driver gives up stepping after this; polls can still finish it. */
const DRIVER_MAX_MS = 10 * 60_000;
/** A pending install older than this (no step for a while) may be replaced by a new one. */
const STALE_MS = 10 * 60_000;
const HTTP_MS = 15_000;

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

export const mcpUrlFor = (aimpointUrl: string) => `${aimpointUrl.replace(/\/+$/, "")}/api/mcp`;

export function installPrompt(a: { aimpointUrl: string; botName: string; key: string }) {
  const bot = a.botName.replace(/["\r\n\\]/g, "").trim() || "bot";
  // From the VEC-168 spike (tested end to end on fresh profiles), renamed for Aimpoint in VEC-198: the server is added as
  // "aimpoint" (key in MCP_AIMPOINT_API_KEY, the env var Hermes derives from the name), and the old "vector" entry and
  // its key are only removed once the new one tested fine, so a failed install leaves a working old setup in place.
  // String.raw keeps the \n escapes for Python/printf.
  return String.raw`Aimpoint (the issue tracker at ${a.aimpointUrl}, formerly called Vector) is connecting you as its bot "${bot}". Install Aimpoint's MCP server into your own Hermes config so future Aimpoint tasks reach you. Use your terminal tool for every step, run the commands exactly as written, and do not show the key in your reply.

1. Save the bot key to your profile's secrets file (replaces any old value; prints only its length):
python3 -c "import os,re,pathlib;p=pathlib.Path(os.environ.get('HERMES_HOME') or pathlib.Path.home()/'.hermes')/'.env';k='${a.key}';s=p.read_text() if p.exists() else '';s=re.sub(r'(?m)^MCP_AIMPOINT_API_KEY=.*\n?','',s);s=s+('' if not s or s.endswith('\n') else '\n')+'MCP_AIMPOINT_API_KEY='+k+'\n';p.write_text(s);os.chmod(p,0o600);print('saved',len(k))"

2. Add the server, replacing any existing "aimpoint" entry (never create a second one):
hermes mcp remove aimpoint </dev/null >/dev/null 2>&1; printf 'y\ny\n' | hermes mcp add aimpoint --url ${mcpUrlFor(a.aimpointUrl)} --auth header

3. Check it: hermes mcp test aimpoint
Exit code 0 means it worked. Any other exit code means it failed: run hermes mcp remove aimpoint </dev/null, leave any "vector" entry as it is, and go to the last line.

4. Only if step 3 worked, remove the old "vector" entry and its key (it pointed at the same tracker under its old name; fine if neither exists):
hermes mcp remove vector </dev/null >/dev/null 2>&1; python3 -c "import os,re,pathlib;p=pathlib.Path(os.environ.get('HERMES_HOME') or pathlib.Path.home()/'.hermes')/'.env';s=p.read_text() if p.exists() else '';p.exists() and p.write_text(re.sub(r'(?m)^MCP_VECTOR_API_KEY=.*\n?','',s));print('cleaned')"

Do not restart Hermes or the gateway: the gateway picks the new server up by itself within about a minute, and Aimpoint will check that with a follow-up run.

Your whole reply must be exactly one line:
AIMPOINT_MCP_INSTALL: ok tools=<number of tools reported in step 3>
or
AIMPOINT_MCP_INSTALL: failed reason=<short reason, no secrets>`;
}

export const CHECK_PROMPT = `Aimpoint connection check. Call the Aimpoint MCP tool get_workspace exactly once (it is named like mcp__aimpoint__get_workspace; if it is not in your tool list, try tool_search for "aimpoint get_workspace"). Do not use the terminal and do not change anything. Reply with exactly one line:
AIMPOINT_MCP_CHECK: ok bot=<you.name from the result>
or
AIMPOINT_MCP_CHECK: failed reason=<short reason>`;

/** Agent-written reasons go to the UI: strip anything key-shaped and keep them short. */
const scrub = (s: string) =>
  s
    .replace(/vec_[A-Za-z0-9_-]{8,}/g, "[key]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/**
 * Reads the one-line answer of an install/check run. Accepts the pre-rename VECTOR_MCP_* tags too (a run sent before
 * VEC-198 shipped); `server` says which name that run installed under.
 */
export function parseSentinel(output: string, kind: "install" | "check") {
  const tag = kind === "install" ? "MCP_INSTALL" : "MCP_CHECK";
  const m = new RegExp(`\\b(AIMPOINT|VECTOR)_${tag}:\\s*(ok|failed)\\b(.*)`, "i").exec(output ?? "");
  if (!m) return null;
  const rest = m[3] ?? "";
  const tools = /tools=(\d+)/.exec(rest);
  const reason = /reason=(.*)/.exec(rest);
  return {
    ok: m[2].toLowerCase() === "ok",
    server: (m[1].toUpperCase() === "VECTOR" ? LEGACY_MCP_SERVER_NAME : MCP_SERVER_NAME) as McpServerName,
    tools: tools ? Number(tools[1]) : null,
    reason: reason ? scrub(reason[1]) : null,
  };
}

export const toMcpInstall = (d: BotMcpInstallDoc): BotMcpInstall => ({
  state: d.state,
  phase: d.phase,
  startedAt: d.startedAt.toISOString(),
  finishedAt: d.finishedAt?.toISOString() ?? null,
  tools: d.tools,
  checks: d.checks,
  keyRerolled: d.keyRerolled,
  reason: d.reason,
});

export const installRunning = (d: BotMcpInstallDoc | null | undefined, now = Date.now()) =>
  !!d && d.state === "pending" && now - d.updatedAt.getTime() < STALE_MS;

interface HermesTarget {
  base: string;
  apiKey: string;
}

/** The bot's Hermes API server, or why Aimpoint can't use it. */
export function hermesTarget(bot: BotDoc): HermesTarget | { error: string } {
  const conn = bot.connection;
  if (!conn || conn.method !== "hermes-api") return { error: "This bot isn't connected to Hermes over the Agent API." };
  const apiKey = conn.secretSealed ? unseal(conn.secretSealed) : null;
  if (!conn.url || !apiKey) return { error: "The Hermes connection is missing its address or API key. Run setup again." };
  return { base: hermesBase(conn.url), apiKey };
}

async function hermesFetch(t: HermesTarget, path: string, init?: { method?: string; body?: unknown; idempotencyKey?: string }) {
  return fetch(`${t.base}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${t.apiKey}`,
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(init?.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(HTTP_MS),
  });
}

const networkReason = (err: unknown) => {
  const e = err as Error;
  return e?.name === "TimeoutError" ? "Hermes didn't answer within 15 seconds." : friendlyNetworkError(e);
};

/** Starts a run; returns its id or a human reason. */
async function startRun(t: HermesTarget, body: Record<string, unknown>, idempotencyKey: string): Promise<{ runId: string } | { error: string }> {
  try {
    const res = await hermesFetch(t, "/v1/runs", { method: "POST", body, idempotencyKey });
    if (res.status === 401 || res.status === 403) return { error: "Hermes rejected its API key (API_SERVER_KEY). Run setup again." };
    if (!res.ok) return { error: await httpError(res, "Hermes") };
    const j = (await res.json().catch(() => null)) as { run_id?: string } | null;
    if (!j?.run_id) return { error: "Hermes accepted the run but didn't say which run it started." };
    return { runId: j.run_id };
  } catch (err) {
    return { error: networkReason(err) };
  }
}

type RunPoll = { kind: "running" } | { kind: "done"; status: string; output: string; error: string | null } | { kind: "gone"; error: string } | { kind: "unreachable"; error: string };

async function pollRun(t: HermesTarget, runId: string): Promise<RunPoll> {
  try {
    const res = await hermesFetch(t, `/v1/runs/${encodeURIComponent(runId)}`);
    if (res.status === 404) return { kind: "gone", error: "Hermes no longer knows the run (did its gateway restart?)." };
    if (res.status === 401 || res.status === 403) return { kind: "gone", error: "Hermes rejected its API key (API_SERVER_KEY) while Aimpoint was watching the run." };
    if (!res.ok) return { kind: "unreachable", error: await httpError(res, "Hermes") };
    const j = (await res.json().catch(() => ({}))) as { status?: string; output?: string; error?: unknown };
    const status = String(j.status ?? "");
    if (!TERMINAL.has(status)) return { kind: "running" };
    const error = typeof j.error === "string" ? j.error : j.error && typeof j.error === "object" ? String((j.error as { message?: string }).message ?? "") || null : null;
    return { kind: "done", status, output: String(j.output ?? ""), error };
  } catch (err) {
    return { kind: "unreachable", error: networkReason(err) };
  }
}

async function stopRun(t: HermesTarget, runId: string) {
  try {
    await hermesFetch(t, `/v1/runs/${encodeURIComponent(runId)}/stop`, { method: "POST", body: {} });
  } catch {}
}

const sessionFor = (bot: BotDoc) => `aimpoint-${bot._id.toHexString()}-setup`;

/**
 * Sends the install run and records the attempt. `key` is the bot's current plaintext Aimpoint key (the caller checked
 * or just issued it). Returns the recorded attempt; a failure to start is recorded as `failed` too, so the wizard
 * reads every outcome the same way.
 */
export async function startMcpInstall(bot: BotDoc, org: OrgDoc, key: string, opts: { keyRerolled: boolean; aimpointUrl: string }): Promise<BotMcpInstallDoc> {
  const c = await cols();
  const doc = newAttempt(opts.keyRerolled);
  const t = hermesTarget(bot);
  let started: { runId: string } | { error: string };
  if ("error" in t) started = t;
  else
    started = await startRun(
      t,
      { input: installPrompt({ aimpointUrl: opts.aimpointUrl, botName: bot.name, key }), session_id: sessionFor(bot) },
      `aimpoint-mcp-install-${doc.id}`,
    );
  if ("error" in started) Object.assign(doc, { state: "failed", reason: `Couldn't start the install: ${started.error}`, finishedAt: new Date() });
  else Object.assign(doc, { runId: started.runId, runStartedAt: new Date() });
  doc.updatedAt = new Date();
  await c.bots.updateOne({ _id: bot._id, orgId: org._id }, { $set: { mcpInstall: doc } });
  if (doc.state === "pending") driveMcpInstall(bot._id, doc.id);
  return doc;
}

const newAttempt = (keyRerolled: boolean): BotMcpInstallDoc => {
  const now = new Date();
  return {
    id: randomUUID(),
    state: "pending",
    phase: "install",
    startedAt: now,
    updatedAt: now,
    runId: null,
    runStartedAt: null,
    installedAt: null,
    tools: null,
    checks: 0,
    nextAt: null,
    keyRerolled,
    reason: null,
    finishedAt: null,
    leaseUntil: null,
  };
};

/** Records an install that failed before any run was sent (Hermes unreachable, rejected its key), for the wizard to read like any other outcome. */
export async function recordFailedInstall(bot: BotDoc, reason: string): Promise<BotMcpInstallDoc> {
  const doc = { ...newAttempt(false), state: "failed" as const, reason, finishedAt: new Date() };
  await (await cols()).bots.updateOne({ _id: bot._id, orgId: bot.orgId }, { $set: { mcpInstall: doc } });
  return doc;
}

/** Re-checks the connection before rerolling a key, so an unreachable Hermes doesn't cost the bot its working key. */
export async function preflightHermes(bot: BotDoc): Promise<string | null> {
  const t = hermesTarget(bot);
  if ("error" in t) return t.error;
  const probe = await hermesProbe(bot.connection!.url!, t.apiKey);
  return probe.ok ? null : probe.error;
}

type Step = Partial<BotMcpInstallDoc>;

const fail = (reason: string): Step => ({ state: "failed", reason, finishedAt: new Date() });

/** One step of the state machine. Returns the changes to save (empty = nothing changed but the lease). */
async function step(bot: BotDoc, d: BotMcpInstallDoc): Promise<Step> {
  const now = Date.now();
  const t = hermesTarget(bot);
  if ("error" in t) return fail(t.error);

  if (d.phase === "install" || d.phase === "check") {
    const limit = d.phase === "install" ? INSTALL_RUN_MS : CHECK_RUN_MS;
    // A check passes the moment the bot calls Aimpoint after the check run started; no need to wait for the run.
    if (d.phase === "check" && bot.lastUsedAt && d.runStartedAt && bot.lastUsedAt > d.runStartedAt) {
      return { state: "installed", reason: null, finishedAt: new Date(), runId: null };
    }
    const poll = d.runId ? await pollRun(t, d.runId) : ({ kind: "gone", error: "No run to watch." } as RunPoll);
    const elapsed = now - (d.runStartedAt?.getTime() ?? d.startedAt.getTime());
    if (poll.kind === "running" || poll.kind === "unreachable") {
      if (elapsed < limit) return {};
      const what = d.phase === "install" ? "the install" : "the connection check";
      const mins = Math.round(limit / 60_000);
      let why: string;
      if (poll.kind === "unreachable") why = `Aimpoint lost contact with Hermes during ${what} and gave up after ${mins} minutes. Last error: ${poll.error}`;
      else {
        if (d.runId) await stopRun(t, d.runId);
        why = `Hermes didn't finish ${what} within ${mins} minutes, so Aimpoint stopped it.`;
      }
      return d.phase === "install" ? fail(why) : afterCheck(d, why);
    }
    if (poll.kind === "gone") return d.phase === "install" ? fail(poll.error) : afterCheck(d, poll.error);

    // The run finished.
    if (d.phase === "install") {
      if (poll.status !== "completed") return fail(`The install run ${poll.status}${poll.error ? `: ${scrub(poll.error)}` : "."}`);
      const s = parseSentinel(poll.output, "install");
      if (!s) return fail("Hermes finished the install run without saying whether it worked.");
      if (!s.ok) return fail(`Hermes couldn't install the MCP server: ${s.reason ?? "no reason given"}.`);
      // From now on wake-ups name the server the way this Hermes has it (VEC-198).
      await (await cols()).bots.updateOne({ _id: bot._id }, { $set: { mcpServerName: s.server } });
      const at = new Date();
      return { phase: "waiting", installedAt: at, tools: s.tools, nextAt: new Date(at.getTime() + CHECK_AT_MS[0]), runId: null };
    }
    // Check run finished: re-read lastUsedAt (the bot may have called Aimpoint just before the run ended).
    const fresh = await (await cols()).bots.findOne({ _id: bot._id }, { projection: { lastUsedAt: 1 } });
    if (fresh?.lastUsedAt && d.runStartedAt && fresh.lastUsedAt > d.runStartedAt) return { state: "installed", reason: null, finishedAt: new Date(), runId: null };
    const s = parseSentinel(poll.output, "check");
    const why =
      poll.status !== "completed"
        ? `the check run ${poll.status}${poll.error ? `: ${scrub(poll.error)}` : ""}`
        : s && !s.ok
          ? (s.reason ?? "Hermes couldn't call Aimpoint")
          : s?.ok
            ? "Hermes said it called Aimpoint, but Aimpoint never heard from the bot"
            : "Hermes didn't call Aimpoint";
    return afterCheck(d, why);
  }

  // waiting
  if (d.nextAt && now < d.nextAt.getTime()) return {};
  const started = await startRun(t, { input: CHECK_PROMPT, session_id: sessionFor(bot) }, `aimpoint-mcp-check-${d.id}-${d.checks + 1}`);
  if ("error" in started) return afterCheck({ ...d, checks: d.checks + 1 }, started.error);
  return { phase: "check", runId: started.runId, runStartedAt: new Date(), checks: d.checks + 1, nextAt: null };
}

/** A check didn't pass: schedule the next one, or give up after MAX_CHECKS. */
function afterCheck(d: BotMcpInstallDoc, why: string): Step {
  const checks = d.checks;
  if (checks >= MAX_CHECKS) {
    const mins = d.installedAt ? Math.max(1, Math.round((Date.now() - d.installedAt.getTime()) / 60_000)) : null;
    return {
      ...fail(
        `Hermes installed the MCP server, but still hadn't loaded Aimpoint's tools${mins ? ` ${mins} minutes later` : ""} (last check: ${scrub(why)}). Try the install again in a few minutes, or set it up by hand.`,
      ),
      runId: null,
      checks,
    };
  }
  const due = (d.installedAt?.getTime() ?? Date.now()) + CHECK_AT_MS[checks];
  return { phase: "waiting", runId: null, checks, nextAt: new Date(Math.max(due, Date.now() + MIN_CHECK_GAP_MS)) };
}

/**
 * Advances a pending install by at most one step, if no one else is stepping it. Safe to call from every poll.
 * Returns the latest attempt (or null if the bot has none).
 */
export async function advanceMcpInstall(botId: ObjectId, attemptId?: string): Promise<BotMcpInstallDoc | null> {
  const c = await cols();
  const now = new Date();
  const leased = await c.bots.findOneAndUpdate(
    {
      _id: botId,
      "mcpInstall.state": "pending",
      ...(attemptId ? { "mcpInstall.id": attemptId } : {}),
      $or: [{ "mcpInstall.leaseUntil": null }, { "mcpInstall.leaseUntil": { $lt: now } }],
    },
    { $set: { "mcpInstall.leaseUntil": new Date(now.getTime() + LEASE_MS) } },
    { returnDocument: "after" },
  );
  if (!leased?.mcpInstall) return (await c.bots.findOne({ _id: botId }, { projection: { mcpInstall: 1 } }))?.mcpInstall ?? null;
  const d = leased.mcpInstall;
  let change: Step;
  try {
    change = await step(leased, d);
  } catch (err) {
    console.error("[mcp install] step failed:", (err as Error)?.message);
    change = {};
  }
  const set: Record<string, unknown> = { "mcpInstall.leaseUntil": null };
  if (Object.keys(change).length) {
    for (const [k, v] of Object.entries(change)) set[`mcpInstall.${k}`] = v;
    set["mcpInstall.updatedAt"] = new Date();
  }
  const saved = await c.bots.findOneAndUpdate({ _id: botId, "mcpInstall.id": d.id }, { $set: set }, { returnDocument: "after", projection: { mcpInstall: 1 } });
  return saved?.mcpInstall ?? null;
}

/** Steps the install in the background until it settles. Never throws into the caller. */
export function driveMcpInstall(botId: ObjectId, attemptId: string) {
  const job = async () => {
    const until = Date.now() + DRIVER_MAX_MS;
    try {
      while (Date.now() < until) {
        const d = await advanceMcpInstall(botId, attemptId);
        if (!d || d.id !== attemptId || d.state !== "pending") return;
        await new Promise((r) => setTimeout(r, DRIVER_TICK_MS));
      }
    } catch (err) {
      console.error("[mcp install] driver stopped:", (err as Error)?.message);
    }
  };
  try {
    after(job);
  } catch {
    void job();
  }
}
