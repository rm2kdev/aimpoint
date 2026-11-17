import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { toProjectDetail } from "@/lib/data";
import { ProjectDetail } from "@/components/settings/project-detail";
import { loadFlowStepCounts, loadProjectFlowSettings } from "@/lib/flows";
import { listProjectForms } from "@/lib/project-forms";

export async function generateMetadata({ params }: PageProps<"/o/[org]/settings/projects/[id]">) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) return { title: "Project" };
  const project = await (await cols()).projects.findOne({ _id: new ObjectId(id) }, { projection: { name: 1 } });
  return { title: `${project?.name ?? "Project"} · Projects` };
}

export default async function ProjectSettingsPage({ params }: PageProps<"/o/[org]/settings/projects/[id]">) {
  const { org: slug, id } = await params;
  const { org, user, isAdmin } = await requireOrgPage(slug);
  if (!ObjectId.isValid(id)) notFound();
  const c = await cols();
  const project = await c.projects.findOne({ _id: new ObjectId(id), orgId: org._id });
  if (!project) notFound();
  const [taskCount, archivedTaskCount, flow, flowCounts, forms, formCount] = await Promise.all([
    c.tasks.countDocuments({ orgId: org._id, projectId: project._id }),
    c.tasks.countDocuments({ orgId: org._id, projectId: project._id, archivedAt: { $ne: null } }),
    loadProjectFlowSettings(org._id, project._id),
    loadFlowStepCounts(org._id, { projectId: project._id }),
    // External forms (VEC-206): the full list for admins only; members just see how many there are.
    isAdmin ? listProjectForms({ orgId: org._id, userId: user._id, isAdmin }, id) : null,
    c.projectForms.countDocuments({ orgId: org._id, projectId: project._id }),
  ]);
  return (
    <ProjectDetail
      key={id}
      project={toProjectDetail(project)}
      taskCount={taskCount}
      archivedTaskCount={archivedTaskCount}
      flow={flow}
      flowCounts={flowCounts}
      forms={forms}
      formCount={formCount}
    />
  );
}
