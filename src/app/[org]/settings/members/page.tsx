import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { loadWorkStats } from "@/lib/data";
import { MembersSettings, type MemberStats } from "@/components/settings/members";

export const metadata = { title: "Members · Settings" };

export default async function MembersPage({ params }: PageProps<"/[org]/settings/members">) {
  const { org: slug } = await params;
  const { org, isAdmin } = await requireOrgPage(slug);
  const c = await cols();
  const [memberships, invites] = await Promise.all([
    c.memberships.find({ orgId: org._id }).toArray(),
    isAdmin
      ? c.invites.find({ orgId: org._id, acceptedAt: { $exists: false }, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).toArray()
      : [],
  ]);
  const work = await loadWorkStats(org._id, memberships.map((m) => m.userId));
  const stats: Record<string, MemberStats> = {};
  for (const m of memberships) {
    const id = m.userId.toHexString();
    stats[id] = { ...work[id], joinedAt: m.createdAt.toISOString() };
  }
  return (
    <MembersSettings
      stats={stats}
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
