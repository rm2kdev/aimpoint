// Pure helpers for the bot status tray (client-safe, node-testable).
/** "working on 2 of 3 tasks, at capacity", "also on VEC-12", "on VEC-12 and VEC-14" (runs with no claim, VEC-381). */
export function trayLabel(active: number, max: number, replying: string[]): string {
  const keys = replying.length <= 3 ? joinKeys(replying) : `${replying.slice(0, 2).join(", ")} and ${replying.length - 2} more`;
  if (!active) return `running on ${keys}`;
  const base = `working on ${active} of ${max} task${max === 1 ? "" : "s"}${active > max ? ", over capacity" : active >= max ? ", at capacity" : ""}`;
  return replying.length ? `${base}, also running on ${keys}` : base;
}

const joinKeys = (keys: string[]) => (keys.length < 2 ? (keys[0] ?? "") : `${keys.slice(0, -1).join(", ")} and ${keys[keys.length - 1]}`);
