import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { loadWorkStats, toBot } from "@/lib/data";
import { BotsSettings } from "@/components/settings/bots";

export const metadata = { title: "Bots · Settings" };

export default async function BotsPage({ params }: PageProps<"/[org]/settings/bots">) {
  const { org: slug } = await params;
  const { org } = await requireOrgPage(slug);
  const bots = await (await cols()).bots.find({ orgId: org._id }).sort({ name: 1 }).toArray();
  const stats = await loadWorkStats(org._id, bots.map((b) => b._id));
  return <BotsSettings bots={bots.map(toBot)} stats={stats} />;
}
