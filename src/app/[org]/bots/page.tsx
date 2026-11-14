import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { toBot } from "@/lib/data";
import { BotsView } from "@/components/bots/bots-view";

export const metadata = { title: "Bots" };

export default async function BotsPage({ params }: PageProps<"/[org]/bots">) {
  const { org: slug } = await params;
  const { org } = await requireOrgPage(slug);
  const c = await cols();
  const bots = await c.bots.find({ orgId: org._id }).sort({ name: 1 }).toArray();
  const ids = bots.map((b) => b._id);
  const [assigned, created] = await Promise.all([
    c.tasks.aggregate<{ _id: string; n: number }>([{ $match: { orgId: org._id, assigneeId: { $in: ids } } }, { $group: { _id: "$assigneeId", n: { $sum: 1 } } }]).toArray(),
    c.tasks.aggregate<{ _id: string; n: number }>([{ $match: { orgId: org._id, createdBy: { $in: ids } } }, { $group: { _id: "$createdBy", n: { $sum: 1 } } }]).toArray(),
  ]);
  const stats: Record<string, { assigned: number; created: number }> = {};
  for (const b of bots) stats[b._id.toHexString()] = { assigned: 0, created: 0 };
  for (const a of assigned) stats[String(a._id)].assigned = a.n;
  for (const a of created) stats[String(a._id)].created = a.n;
  return <BotsView bots={bots.map(toBot)} stats={stats} />;
}
