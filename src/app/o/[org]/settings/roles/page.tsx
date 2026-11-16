import { redirect } from "next/navigation";
import { rolesPath } from "@/lib/paths";

/** Bot roles are a section of the Bots page since VEC-125. */
export default async function OldRolesPage({ params }: PageProps<"/o/[org]/settings/roles">) {
  const { org } = await params;
  redirect(rolesPath(org));
}
