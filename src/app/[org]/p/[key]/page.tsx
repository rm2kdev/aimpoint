import { notFound } from "next/navigation";
import { requireOrgPage } from "@/lib/session";
import { listTasks } from "@/lib/data";
import { cols } from "@/lib/db";
import { TaskWorkspace } from "@/components/task-workspace";

export async function generateMetadata({ params }: PageProps<"/[org]/p/[key]">) {
  const { org: slug, key } = await params;
  const { org } = await requireOrgPage(slug);
  const project = await (await cols()).projects.findOne({ orgId: org._id, key: key.toUpperCase() });
  return { title: project?.name ?? key.toUpperCase() };
}

export default async function ProjectPage({ params }: PageProps<"/[org]/p/[key]">) {
  const { org: slug, key } = await params;
  const { org } = await requireOrgPage(slug);
  const c = await cols();
  const project = await c.projects.findOne({ orgId: org._id, key: key.toUpperCase() });
  if (!project) notFound();
  const projectId = project._id.toHexString();
  const tasks = await listTasks(org._id, { projectId });
  return (
    <TaskWorkspace
      key={projectId}
      title={project.name}
      scope={{ projectId }}
      initialTasks={tasks}
      showProject={false}
      emptyHint={`Issues and feature requests for ${project.name} live here.`}
    />
  );
}
