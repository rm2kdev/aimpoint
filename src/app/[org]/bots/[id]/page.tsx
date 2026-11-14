import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { toBot, toTask } from "@/lib/data";
import { BotSettings } from "@/components/bots/bot-settings";
import type { TaskDoc } from "@/lib/types";

export async function generateMetadata({ params }: PageProps<"/[org]/bots/[id]">) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) return { title: "Bot" };
  const bot = await (await cols()).bots.findOne({ _id: new ObjectId(id) }, { projection: { name: 1 } });
  return { title: bot?.name ?? "Bot" };
}

export default async function BotPage({ params }: PageProps<"/[org]/bots/[id]">) {
  const { org: slug, id } = await params;
  const { org } = await requireOrgPage(slug);
  if (!ObjectId.isValid(id)) notFound();
  const c = await cols();
  const bot = await c.bots.findOne({ _id: new ObjectId(id), orgId: org._id });
  if (!bot) notFound();
  const [assignedDocs, createdCount, projects] = await Promise.all([
    c.tasks.find({ orgId: org._id, assigneeId: bot._id }, { projection: { description: 0 } }).sort({ updatedAt: -1 }).limit(50).toArray(),
    c.tasks.countDocuments({ orgId: org._id, createdBy: bot._id }),
    c.projects.find({ orgId: org._id }).toArray(),
  ]);
  const keys = new Map(projects.map((p) => [p._id.toHexString(), p.key]));
  const assigned = assignedDocs.map((d) => toTask(d as TaskDoc, keys.get(d.projectId.toHexString()) ?? "?"));
  return <BotSettings key={bot._id.toHexString()} bot={toBot(bot)} assigned={assigned} createdCount={createdCount} />;
}
