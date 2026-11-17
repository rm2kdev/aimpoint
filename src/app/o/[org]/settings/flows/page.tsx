import { requireOrgPage } from "@/lib/session";
import { loadFlowStepCounts, loadOrgFlowSettings, loadProjectFlowSummaries } from "@/lib/flows";
import { OrgFlowSettings } from "@/components/settings/flow-settings";

export const metadata = { title: "Flows · Settings" };

/** Settings > Flows (VEC-177): the org default flow. Refreshed on org.changed like every settings page. */
export default async function FlowsPage({ params }: PageProps<"/o/[org]/settings/flows">) {
  const { org: slug } = await params;
  const { org } = await requireOrgPage(slug);
  const [flow, projects, counts] = await Promise.all([
    loadOrgFlowSettings(org._id),
    loadProjectFlowSummaries(org._id),
    loadFlowStepCounts(org._id, { source: "org" }),
  ]);
  return <OrgFlowSettings flow={flow} projects={projects} counts={counts} />;
}
