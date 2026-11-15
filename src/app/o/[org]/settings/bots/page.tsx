import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { loadWorkStats, toBot } from "@/lib/data";
import { BotsSettings } from "@/components/settings/bots";

export const metadata = { title: "Bots · Settings" };

export default async function BotsPage({ params }: PageProps<"/o/[org]/settings/bots">) {
  const { org: slug } = await params;
  const { org } = await requireOrgPage(slug);
  const c = await cols();
  const [bots, roles] = await Promise.all([c.bots.find({ orgId: org._id }).sort({ name: 1 }).toArray(), c.botRoles.find({ orgId: org._id }).toArray()]);
  const stats = await loadWorkStats(org._id, bots.map((b) => b._id));
  const roleNames = Object.fromEntries(roles.map((r) => [r._id.toHexString(), r.name]));
  return <BotsSettings bots={bots.map(toBot)} stats={stats} roleNames={roleNames} />;
}
