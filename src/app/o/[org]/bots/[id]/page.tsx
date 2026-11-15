import { redirect } from "next/navigation";
import { orgPath } from "@/lib/paths";

export default async function OldBot({ params }: PageProps<"/o/[org]/bots/[id]">) {
  const { org, id } = await params;
  redirect(orgPath(org, "settings", "bots", id));
}
