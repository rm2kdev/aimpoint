import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { loadWorkStats, toBot, toBotRole } from "@/lib/data";
import { BotsSettings } from "@/components/settings/bots";
import { RolesSettings } from "@/components/settings/roles";

export const metadata = { title: "Bots · Settings" };

export default async function BotsPage({ params }: PageProps<"/o/[org]/settings/bots">) {
  const { org: slug } = await params;
  const { org } = await requireOrgPage(slug);
  const c = await cols();
  const [bots, roles] = await Promise.all([c.bots.find({ orgId: org._id }).sort({ name: 1 }).toArray(), c.botRoles.find({ orgId: org._id }).sort({ name: 1 }).toArray()]);
  const stats = await loadWorkStats(org._id, bots.map((b) => b._id));
  const roleNames = Object.fromEntries(roles.map((r) => [r._id.toHexString(), r.name]));
  const usage: Record<string, number> = {};
  for (const b of bots) if (b.roleId) usage[b.roleId.toHexString()] = (usage[b.roleId.toHexString()] ?? 0) + 1;
  return (
    <>
      <BotsSettings bots={bots.map(toBot)} stats={stats} roleNames={roleNames} />
      <RolesSettings roles={roles.map(toBotRole)} usage={usage} />
    </>
  );
}
