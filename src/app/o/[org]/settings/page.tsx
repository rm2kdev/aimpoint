import { redirect } from "next/navigation";
import { newTasksPath, orgPath, rolesPath } from "@/lib/paths";

// Setup order (VEC-187): people and bots first, then projects, then the flow that hands work between them.
// "statuses" is per project since VEC-117: old ?tab=statuses links land on Projects. Bot roles live on the Bots page since VEC-125.
// Defaults is folded into Flows since VEC-187: old ?tab=defaults links land on its New tasks row.
const TABS = ["general", "members", "bots", "projects", "flows"];

/** /settings (and old ?tab= links) land on a section. */
export default async function SettingsIndex({ params, searchParams }: PageProps<"/o/[org]/settings">) {
  const { org } = await params;
  const { tab, new: isNew } = await searchParams;
  if (tab === "roles") redirect(rolesPath(org));
  if (tab === "defaults") redirect(newTasksPath(org));
  const t = tab === "statuses" ? "projects" : typeof tab === "string" && TABS.includes(tab) ? tab : "general";
  redirect(`${orgPath(org, "settings", t)}${t === "projects" && isNew === "1" ? "?new=1" : ""}`);
}
