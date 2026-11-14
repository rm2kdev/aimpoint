import { requireOrgPage } from "@/lib/session";
import { listTasks } from "@/lib/data";
import { TaskWorkspace } from "@/components/task-workspace";

export const metadata = { title: "My Tasks" };

export default async function MyTasks({ params }: PageProps<"/[org]/my">) {
  const { org: slug } = await params;
  const { org, user } = await requireOrgPage(slug);
  const tasks = await listTasks(org._id, { assigneeId: user._id.toHexString() });
  return (
    <TaskWorkspace
      title="My Tasks"
      scope={{ mine: true }}
      initialTasks={tasks}
      showProject
      emptyHint="Tasks assigned to you in any project show up here."
    />
  );
}
