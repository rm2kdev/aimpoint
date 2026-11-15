import { redirect } from "next/navigation";
import { orgPath } from "@/lib/paths";

const TABS = ["general", "projects", "statuses", "members", "bots", "roles"];

/** /settings (and old ?tab= links) land on a section. */
export default async function SettingsIndex({ params, searchParams }: PageProps<"/o/[org]/settings">) {
  const { org } = await params;
  const { tab, new: isNew } = await searchParams;
  const t = typeof tab === "string" && TABS.includes(tab) ? tab : "general";
  redirect(`${orgPath(org, "settings", t)}${t === "projects" && isNew === "1" ? "?new=1" : ""}`);
}
