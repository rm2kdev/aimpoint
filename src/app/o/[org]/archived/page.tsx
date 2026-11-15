import { requireOrgPage } from "@/lib/session";
import { listTasks } from "@/lib/data";
import { TaskWorkspace } from "@/components/task-workspace";

export const metadata = { title: "Archive" };

export default async function ArchivedTasks({ params }: PageProps<"/o/[org]/archived">) {
  const { org: slug } = await params;
  const { org } = await requireOrgPage(slug);
  const tasks = await listTasks(org._id, { archived: true });
  return (
    <TaskWorkspace
      title="Archive"
      scope={{ archived: true }}
      initialTasks={tasks}
      showProject
      emptyHint="Archived tasks land here, out of every other view. Restore one any time."
    />
  );
}
