import { requireOrgPage } from "@/lib/session";
import { listTasks } from "@/lib/data";
import { TaskWorkspace } from "@/components/task-workspace";

export const metadata = { title: "All Tasks" };

export default async function AllTasks({ params }: PageProps<"/[org]/all">) {
  const { org: slug } = await params;
  const { org } = await requireOrgPage(slug);
  const tasks = await listTasks(org._id, {});
  return (
    <TaskWorkspace
      title="All Tasks"
      scope={{}}
      initialTasks={tasks}
      showProject
      emptyHint="Capture the first issue or feature request for your team."
    />
  );
}
