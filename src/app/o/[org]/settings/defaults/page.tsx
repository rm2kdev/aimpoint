import { redirect } from "next/navigation";
import { newTasksPath } from "@/lib/paths";

/** Settings > Defaults was folded into Flows (VEC-187): old links land on its New tasks row. */
export default async function DefaultsPage({ params }: PageProps<"/o/[org]/settings/defaults">) {
  const { org } = await params;
  redirect(newTasksPath(org));
}
