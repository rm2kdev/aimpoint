import { requireOrgPage } from "@/lib/session";
import { loadShell, loadWorkloadSnapshot } from "@/lib/data";
import { cols } from "@/lib/db";
import { realtimeDriver } from "@/lib/realtime/server";
import { unreadCount } from "@/lib/notifications";
import { loadDeletedMembers } from "@/lib/deleted-users";
import { loadOrgDefaults } from "@/lib/org-defaults";
import { loadClientFlows } from "@/lib/flow-view";
import { loadBillingSummary } from "@/lib/billing-summary";
import { OrgProvider } from "@/components/org-provider";
import { AppShell } from "@/components/app-shell";

export default async function OrgLayout({ children, params }: LayoutProps<"/o/[org]">) {
  const { org: slug } = await params;
  const { user, org, membership } = await requireOrgPage(slug);
  const c = await cols();
  const [shell, myMemberships, unread, workload, deletedMembers, defaults, flows, billing] = await Promise.all([
    loadShell(org._id, user._id),
    c.memberships.find({ userId: user._id }).toArray(),
    unreadCount(org._id, user._id),
    loadWorkloadSnapshot(org._id),
    loadDeletedMembers(org._id),
    loadOrgDefaults(org._id),
    loadClientFlows(org._id),
    loadBillingSummary(org),
  ]);
  const orgs = await c.orgs.find({ _id: { $in: myMemberships.map((m) => m.orgId) } }).sort({ name: 1 }).toArray();

  return (
    <OrgProvider
      org={{ id: org._id.toHexString(), name: org.name, slug: org.slug }}
      orgs={orgs.map((o) => ({ id: o._id.toHexString(), name: o.name, slug: o.slug }))}
      me={{ id: user._id.toHexString(), name: user.name, email: user.email, role: membership.role, image: user.image ?? null }}
      members={shell.members}
      deletedMembers={deletedMembers}
      projects={shell.projects}
      projectOrder={shell.projectOrder}
      statuses={shell.statuses}
      defaults={defaults}
      flows={flows}
      billing={billing}
      counts={shell.counts}
      unread={unread}
      workload={workload}
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
