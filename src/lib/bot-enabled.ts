// Whether a bot is switched on (VEC-342/343). An admin can disable a bot without deleting it: it stays in the org with
// its assignments, history and settings, but isn't woken, offered for assignment or triage, listed to agents, or let in
// with its key until it's enabled again. Pure and client-safe (no value imports), unit tested in bot-enabled.test.mjs.
//
// Stored as `disabledAt` (+ `disabledBy`) on the bot doc. A missing or null `disabledAt` reads as enabled, so bots
// created before VEC-343 need no migration. Enforcement (VEC-344) and UI (VEC-345) go through these helpers.

/** Anything carrying a bot's enabled state: a BotDoc (`disabledAt`), or the client `Bot` view (`enabled`). */
export type BotEnabledLike = { disabledAt?: Date | string | null } | { enabled: boolean };

/** True unless the bot has been disabled. Missing fields read as enabled. */
export function isBotEnabled(bot: BotEnabledLike | null | undefined): boolean {
  if (!bot) return false;
  if ("enabled" in bot && typeof bot.enabled === "boolean") return bot.enabled;
  const at = (bot as { disabledAt?: Date | string | null }).disabledAt;
  return at === undefined || at === null;
}

/**
 * Mongo filter fragment for enabled bots: `{disabledAt: null}` matches both a missing field and an explicit null.
 * Spread it into a `bots` query: `c.bots.find({ orgId, ...ENABLED_BOT_FILTER })`.
 */
export const ENABLED_BOT_FILTER = { disabledAt: null } as const;

/** Mongo filter fragment for disabled bots (the complement of ENABLED_BOT_FILTER). */
export const DISABLED_BOT_FILTER = { disabledAt: { $ne: null } } as const;

/** Only the enabled bots of a list (BotDocs or `Bot` views), order kept. */
export function enabledBots<T extends BotEnabledLike>(bots: readonly T[]): T[] {
  return bots.filter((b) => isBotEnabled(b));
}

/**
 * The bot-doc update that sets the state: disabling stamps when and by whom, enabling clears both. Pair it with
 * botEnabledFlipFilter so a repeat disable keeps the first stamp instead of rewriting it.
 */
export function botEnabledUpdate<Id>(enabled: boolean, actorId: Id, now: Date): { $set: { disabledAt: Date | null; disabledBy: Id | null } } {
  return enabled ? { $set: { disabledAt: null, disabledBy: null } } : { $set: { disabledAt: now, disabledBy: actorId } };
}

/** The `{disabledAt}` match that makes a toggle a real change: only flip a bot that's currently in the other state. */
export function botEnabledFlipFilter(enabled: boolean) {
  return enabled ? DISABLED_BOT_FILTER : ENABLED_BOT_FILTER;
}

/* ---------------- enforcement (VEC-344) ---------------- */

/** What a disabled bot's key gets back on MCP and the REST API (403). */
export function disabledKeyMessage(orgName: string): string {
  return `This bot is disabled in ${orgName}; an admin can re-enable it in Settings > Bots.`;
}

/** Why a wake-up wasn't sent: the bot is disabled (a refused delivery, e.g. the connection test). */
export function disabledWakeMessage(botName: string): string {
  return `${botName} is disabled, so it isn't woken. Enable it to send wake-ups again.`;
}

/** Why a task can't be assigned to a disabled bot (MCP assign/create/update and the app's actions). */
export function disabledAssigneeMessage(botName: string, orgName: string): string {
  return `${botName} is disabled in ${orgName}, so it can't be assigned tasks. An admin can re-enable it in Settings > Bots.`;
}

/**
 * The people and bots an agent is shown (get_workspace, check_for_triage's workspace, REST /members): disabled bots
 * are left out. Names still resolve elsewhere (the directory keeps them), so existing assignees and history render.
 */
export function listedToAgents<T extends { kind: string; disabled?: boolean }>(people: readonly T[]): T[] {
  return people.filter((p) => p.kind !== "bot" || !p.disabled);
}

/**
 * The push triagers to try for a Triage task, in order: the preferred one first (a resumed triage), then the rest as
 * given; disabled bots and `exclude` (the task's creator) are skipped. `waiting` is true when only disabled triagers
 * were left, so the task is held in Triage until one is enabled again.
 */
export function triageOrder<T extends BotEnabledLike & { _id: { equals(o: unknown): boolean } }>(
  bots: readonly T[],
  opts: { exclude?: unknown; prefer?: unknown } = {},
): { order: T[]; waiting: boolean } {
  const pool = opts.exclude ? bots.filter((b) => !b._id.equals(opts.exclude)) : [...bots];
  const enabled = enabledBots(pool);
  const first = opts.prefer ? enabled.filter((b) => b._id.equals(opts.prefer)) : [];
  return { order: [...first, ...enabled.filter((b) => !first.includes(b))], waiting: !enabled.length && pool.length > 0 };
}
