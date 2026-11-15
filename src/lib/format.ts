const AVATAR_COLORS = ["#2f6fed", "#e5484d", "#30a46c", "#8b5cf6", "#d6409f", "#0e9aa7", "#e38c0a", "#5b6b7f"];

export function avatarColor(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });
export function timeAgo(iso: string, now = Date.now()) {
  const s = Math.round((new Date(iso).getTime() - now) / 1000);
  const a = Math.abs(s);
  if (a < 45) return "now";
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (a < 86400 * 7) return rtf.format(Math.round(s / 86400), "day");
  return new Date(iso).toLocaleDateString("en", { day: "numeric", month: "short" });
}

export const PRIORITY_LABELS = ["No priority", "Low", "Medium", "High"] as const;
export const TYPE_LABELS = { issue: "Issue", feature: "Feature", task: "Task" } as const;
/** Longer names for pickers and the task pane ("Feature request" rather than the tag's "Feature"). */
export const TYPE_NAMES = { issue: "Issue", feature: "Feature request", task: "Task" } as const;
