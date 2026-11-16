import { redirect } from "next/navigation";
import { orgPath } from "@/lib/paths";

// "statuses" is per project since VEC-117: old ?tab=statuses links land on Projects.
const TABS = ["general", "projects", "members", "bots", "roles"];

/** /settings (and old ?tab= links) land on a section. */
export default async function SettingsIndex({ params, searchParams }: PageProps<"/o/[org]/settings">) {
  const { org } = await params;
  const { tab, new: isNew } = await searchParams;
  const t = tab === "statuses" ? "projects" : typeof tab === "string" && TABS.includes(tab) ? tab : "general";
  redirect(`${orgPath(org, "settings", t)}${t === "projects" && isNew === "1" ? "?new=1" : ""}`);
}
