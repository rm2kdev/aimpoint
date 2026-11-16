import { redirect } from "next/navigation";
import { orgPath } from "@/lib/paths";

/** Statuses belong to projects now (VEC-117): each project's settings page has its own Statuses editor. */
export default async function StatusesPage({ params }: PageProps<"/o/[org]/settings/statuses">) {
  const { org } = await params;
  redirect(orgPath(org, "settings", "projects"));
}
