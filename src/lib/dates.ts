/** Due dates are calendar days ("YYYY-MM-DD"), compared in the viewer's local time zone. */

export function toISODate(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function fromISODate(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d: Date, n: number) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function today() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Whole days from today to the due date (negative = overdue). */
export function daysUntil(due: string) {
  return Math.round((fromISODate(due).getTime() - today().getTime()) / 86_400_000);
}

export type DueState = "overdue" | "today" | "soon" | "later";

export function dueState(due: string): DueState {
  const n = daysUntil(due);
  return n < 0 ? "overdue" : n === 0 ? "today" : n <= 7 ? "soon" : "later";
}

/** "Today", "Tomorrow", "Yesterday", "Fri", "30 Nov", "30 Nov 2027". */
export function formatDue(due: string, long = false) {
  const n = daysUntil(due);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  const d = fromISODate(due);
  if (n > 1 && n < 7 && !long) return d.toLocaleDateString("en-AU", { weekday: "short" });
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("en-AU", {
    weekday: long ? "short" : undefined,
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
  });
}

/** Absolute, for history: "Mon, 16 Nov" (year added when it isn't this year). */
export function formatDueAbsolute(due: string) {
  const d = fromISODate(due);
  return d.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

/** "12 Nov 2026" */
export function formatDay(iso: string) {
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}
