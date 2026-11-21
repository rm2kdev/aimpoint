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
