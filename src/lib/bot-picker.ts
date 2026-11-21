// How disabled bots (VEC-343) show up in the app's bot pickers and on tasks (VEC-345). Pure and client-safe, unit tested
// in bot-picker.test.mjs. A disabled bot stays in the org's member list so its tasks, comments and history still
// render, but it is listed after the enabled bots, grayed and can't be picked; a task that already has it keeps it.

/** The bits of a `Member` (or `Bot` view) these helpers read. */
export interface PickerBot {
  id: string;
  name: string;
  /** Member shape: true when an admin switched the bot off. */
  disabled?: boolean;
  /** Bot view shape. */
  enabled?: boolean;
}

/** True when the bot has been switched off (either shape). Unknown or missing bots read as not disabled. */
export function isBotDisabled(bot: PickerBot | null | undefined): boolean {
  if (!bot) return false;
  if (typeof bot.enabled === "boolean") return !bot.enabled;
  return bot.disabled === true;
}

/** Hint shown next to a disabled bot in a picker. */
export const DISABLED_BOT_HINT = "Disabled";

/** One line saying why a disabled bot is grayed, for titles and the task pane. */
export function disabledBotNote(name: string): string {
  return `${name} is disabled. It keeps its tasks but isn't woken until an admin enables it again.`;
}

/**
 * Bot picker entries in order: enabled bots first (order kept), then disabled ones, each flagged `disabled` so the
 * picker renders it grayed and unselectable. Pass `sort` to order each part (e.g. by name).
 */
export function botPickerEntries<T extends PickerBot>(bots: readonly T[], sort?: (a: T, b: T) => number): { bot: T; disabled: boolean }[] {
  const on = bots.filter((b) => !isBotDisabled(b));
  const off = bots.filter((b) => isBotDisabled(b));
  if (sort) {
    on.sort(sort);
    off.sort(sort);
  }
  return [...on.map((bot) => ({ bot, disabled: false })), ...off.map((bot) => ({ bot, disabled: true }))];
}
