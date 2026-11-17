import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { loadOpenAssigned, toBot, toBotRole } from "@/lib/data";
import { BotDetail } from "@/components/settings/bot-detail";
import { loadBotFlowPlaces } from "@/lib/flows";

export async function generateMetadata({ params }: PageProps<"/o/[org]/settings/bots/[id]">) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) return { title: "Bot" };
  const bot = await (await cols()).bots.findOne({ _id: new ObjectId(id) }, { projection: { name: 1 } });
  return { title: `${bot?.name ?? "Bot"} · Bots` };
}

export default async function BotPage({ params }: PageProps<"/o/[org]/settings/bots/[id]">) {
  const { org: slug, id } = await params;
  const { org } = await requireOrgPage(slug);
  if (!ObjectId.isValid(id)) notFound();
  const c = await cols();
  const bot = await c.bots.findOne({ _id: new ObjectId(id), orgId: org._id });
  if (!bot) notFound();
  const [assigned, createdCount, roles, claims] = await Promise.all([
    loadOpenAssigned(org._id, bot._id),
    c.tasks.countDocuments({ orgId: org._id, createdBy: bot._id }),
    c.botRoles.find({ orgId: org._id }).sort({ name: 1 }).toArray(),
    c.agentClaims.find({ botId: bot._id, state: "in_progress" }, { projection: { taskId: 1 } }).toArray(),
  ]);
  // Role-less bots get every tool except the opt-in triage one, so only a role with it switched on makes a triage bot.
  const triage = !!(bot.roleId && roles.find((r) => r._id.equals(bot.roleId!))?.tools.check_for_triage);
  const flowPlaces = await loadBotFlowPlaces(org._id, bot._id, { triage });
  return (
    <BotDetail
      key={id}
      bot={toBot(bot)}
      assigned={assigned}
      createdCount={createdCount}
      roles={roles.map(toBotRole)}
      pickedUp={claims.map((x) => x.taskId.toHexString())}
      flowPlaces={flowPlaces}
    />
  );
}
