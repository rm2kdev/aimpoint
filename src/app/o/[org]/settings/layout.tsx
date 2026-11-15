import { requireOrgPage } from "@/lib/session";
import { SettingsFrame } from "@/components/settings/ui";

export default async function SettingsLayout({ params, children }: LayoutProps<"/o/[org]/settings">) {
  const { org } = await params;
  await requireOrgPage(org);
  return <SettingsFrame>{children}</SettingsFrame>;
}
