import { redirect } from "next/navigation";
import { orgPath } from "@/lib/paths";

export default async function OrgIndex({ params }: PageProps<"/o/[org]">) {
  const { org } = await params;
  redirect(orgPath(org, "my"));
}
