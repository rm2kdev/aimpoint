import { redirect } from "next/navigation";

const TABS = ["general", "projects", "statuses", "members", "bots"];

/** /settings (and old ?tab= links) land on a section. */
export default async function SettingsIndex({ params, searchParams }: PageProps<"/[org]/settings">) {
  const { org } = await params;
  const { tab, new: isNew } = await searchParams;
  const t = typeof tab === "string" && TABS.includes(tab) ? tab : "general";
  redirect(`/${org}/settings/${t}${t === "projects" && isNew === "1" ? "?new=1" : ""}`);
}
