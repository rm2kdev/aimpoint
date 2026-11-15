import { redirect } from "next/navigation";
import { orgPath } from "@/lib/paths";

export default async function OldBots({ params }: PageProps<"/o/[org]/bots">) {
  const { org } = await params;
  redirect(orgPath(org, "settings", "bots"));
}
