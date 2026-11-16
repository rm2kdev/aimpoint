import { redirect } from "next/navigation";
import { rolePath } from "@/lib/paths";

/** Role detail moved under the Bots tab (VEC-125). */
export default async function OldRolePage({ params }: PageProps<"/o/[org]/settings/roles/[id]">) {
  const { org, id } = await params;
  redirect(rolePath(org, id));
}
