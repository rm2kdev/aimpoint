import { requireOrgPage } from "@/lib/session";
import { loadShell } from "@/lib/data";
import { cols } from "@/lib/db";
import { realtimeDriver } from "@/lib/realtime/server";
import { unreadCount } from "@/lib/notifications";
import { OrgProvider } from "@/components/org-provider";
import { AppShell } from "@/components/app-shell";

export default async function OrgLayout({ children, params }: LayoutProps<"/o/[org]">) {
  const { org: slug } = await params;
  const { user, org, membership } = await requireOrgPage(slug);
  const c = await cols();
  const [shell, myMemberships, unread] = await Promise.all([
    loadShell(org._id, user._id),
    c.memberships.find({ userId: user._id }).toArray(),
    unreadCount(org._id, user._id),
  ]);
  const orgs = await c.orgs.find({ _id: { $in: myMemberships.map((m) => m.orgId) } }).sort({ name: 1 }).toArray();

  return (
    <OrgProvider
      org={{ id: org._id.toHexString(), name: org.name, slug: org.slug }}
      orgs={orgs.map((o) => ({ id: o._id.toHexString(), name: o.name, slug: o.slug }))}
      me={{ id: user._id.toHexString(), name: user.name, email: user.email, role: membership.role }}
      members={shell.members}
      projects={shell.projects}
      statuses={shell.statuses}
      counts={shell.counts}
      unread={unread}
      realtime={{
        driver: realtimeDriver,
        key: process.env.NEXT_PUBLIC_PUSHER_KEY,
        cluster: process.env.NEXT_PUBLIC_PUSHER_CLUSTER,
      }}
    >
      <AppShell>{children}</AppShell>
    </OrgProvider>
  );
}
