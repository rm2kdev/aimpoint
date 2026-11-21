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

/* ---------- VEC-353: mention picker, held mentions, toggle history ---------- */

/**
 * Keyboard step through a list where some entries can't be picked (disabled bots): the next pickable index from
 * `from` in direction `dir`, wrapping. `from` -1 starts before the first (dir 1) or after the last (dir -1).
 * Returns -1 when nothing is pickable.
 */
export function stepPickable(disabled: readonly boolean[], from: number, dir: 1 | -1): number {
  const n = disabled.length;
  if (!n) return -1;
  let i = from < 0 ? (dir === 1 ? -1 : n) : from;
  for (let k = 0; k < n; k++) {
    i = (((i + dir) % n) + n) % n;
    if (!disabled[i]) return i;
  }
  return -1;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Disabled bots a comment names by hand as plain `@Name` text (not a picked `<@id>` token), longest name first so
 * "@Gap Probe 2" isn't also read as "@Gap Probe". The name must start the text or follow whitespace and end at a
 * word boundary. Case-insensitive, like the picker's matching.
 */
export function typedDisabledMentions<T extends PickerBot>(body: string, bots: readonly T[]): { id: string; name: string }[] {
  let rest = body;
  const out: { id: string; name: string }[] = [];
  for (const b of [...bots].filter((x) => isBotDisabled(x) && x.name.trim()).sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`(^|\\s)@${escapeRe(b.name)}(?![\\p{L}\\p{N}_])`, "giu");
    if (re.test(rest)) {
      out.push({ id: b.id, name: b.name });
      rest = rest.replace(re, "$1");
    }
  }
  return out;
}

/** Merge held-mention lists (server `heldMentions` + typed names), first copy of each id kept. */
export function mergeHeldMentions(...lists: readonly (readonly { id: string; name: string }[])[]): { id: string; name: string }[] {
  const seen = new Set<string>();
  const out: { id: string; name: string }[] = [];
  for (const l of lists) {
    for (const m of l) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

/**
 * Toast after posting a comment that names disabled bots, or null when it names none. `held` = picked mentions the
 * server stored but held (delivered once the bot is enabled); `typed` = names typed by hand as plain text, which are
 * never delivered. A bot in both counts as held.
 */
export function heldMentionsToast(held: readonly { id: string; name: string }[], typed: readonly { id: string; name: string }[] = []): { title: string; description: string } | null {
  const later = mergeHeldMentions(held);
  const never = typed.filter((t) => !later.some((h) => h.id === t.id));
  const all = [...later, ...never];
  if (!all.length) return null;
  const names = all.map((h) => h.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const one = names.length === 1;
  const description = !never.length
    ? `The comment is posted. ${one ? "It hears" : "They hear"} about it once an admin enables ${one ? "it" : "them"} again.`
    : !later.length
      ? `The comment is posted, but ${one ? "it isn't" : "they aren't"} told about it. Enable ${one ? "it" : "them"} in Settings > Bots, then mention ${one ? "it" : "them"} again.`
      : "The comment is posted. Picked mentions go out once an admin enables those bots again; names typed by hand never do.";
  return { title: `${list} ${one ? "is" : "are"} disabled and ${one ? "wasn't" : "weren't"} notified`, description };
}

export interface EnabledToggle {
  enabled: boolean;
  at: string;
  by: string;
}

/**
 * The newer of two copies of a bot's toggle history (the page's server prop vs its own copy after a toggle), by
 * the latest entry's time, then length. Returned most recent first for display.
 */
export function enabledHistoryNewestFirst(a: readonly EnabledToggle[] | undefined, b: readonly EnabledToggle[] | undefined): EnabledToggle[] {
  const last = (h: readonly EnabledToggle[] | undefined) => (h?.length ? Date.parse(h[h.length - 1].at) : -Infinity);
  const la = last(a);
  const lb = last(b);
  const pick = la > lb ? a : lb > la ? b : (a?.length ?? 0) >= (b?.length ?? 0) ? a : b;
  return [...(pick ?? [])].sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
}
