import { ProjectsSettings } from "@/components/settings/org-settings";

export const metadata = { title: "Projects · Settings" };

export default async function ProjectsPage({ searchParams }: PageProps<"/o/[org]/settings/projects">) {
  const { new: isNew } = await searchParams;
  return <ProjectsSettings openNew={isNew === "1"} />;
}
