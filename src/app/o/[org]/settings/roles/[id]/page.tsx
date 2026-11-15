import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { toBot, toBotRole } from "@/lib/data";
import { RoleDetail } from "@/components/settings/roles";

export async function generateMetadata({ params }: PageProps<"/o/[org]/settings/roles/[id]">) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) return { title: "Bot role" };
  const role = await (await cols()).botRoles.findOne({ _id: new ObjectId(id) }, { projection: { name: 1 } });
  return { title: `${role?.name ?? "Role"} · Bot roles` };
}

export default async function RolePage({ params }: PageProps<"/o/[org]/settings/roles/[id]">) {
  const { org: slug, id } = await params;
  const { org } = await requireOrgPage(slug);
  if (!ObjectId.isValid(id)) notFound();
  const c = await cols();
  const role = await c.botRoles.findOne({ _id: new ObjectId(id), orgId: org._id });
  if (!role) notFound();
  const bots = await c.bots.find({ orgId: org._id, roleId: role._id }).sort({ name: 1 }).toArray();
  return <RoleDetail key={id} role={toBotRole(role)} bots={bots.map(toBot)} />;
}
