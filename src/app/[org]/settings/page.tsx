import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { SettingsView } from "@/components/settings-view";

export const metadata = { title: "Settings" };

export default async function SettingsPage({ params, searchParams }: PageProps<"/[org]/settings">) {
  const { org: slug } = await params;
  const { tab, new: isNew } = await searchParams;
  const { org, isAdmin } = await requireOrgPage(slug);
  const c = await cols();
  const invites = isAdmin
    ? await c.invites.find({ orgId: org._id, acceptedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).toArray()
    : [];
  return (
    <SettingsView
      initialTab={typeof tab === "string" ? tab : "general"}
      openNewProject={isNew === "1"}
      invites={invites.map((i) => ({
        id: i._id.toHexString(),
        email: i.email,
        role: i.role,
        token: i.token,
        expiresAt: i.expiresAt.toISOString(),
      }))}
    />
  );
}
