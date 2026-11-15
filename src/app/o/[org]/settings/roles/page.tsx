import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { toBotRole } from "@/lib/data";
import { RolesSettings } from "@/components/settings/roles";

export const metadata = { title: "Bot roles · Settings" };

export default async function RolesPage({ params }: PageProps<"/o/[org]/settings/roles">) {
  const { org: slug } = await params;
  const { org } = await requireOrgPage(slug);
  const c = await cols();
  const [roles, bots] = await Promise.all([
    c.botRoles.find({ orgId: org._id }).sort({ name: 1 }).toArray(),
    c.bots.find({ orgId: org._id, roleId: { $ne: null } }, { projection: { roleId: 1 } }).toArray(),
  ]);
  const usage: Record<string, number> = {};
  for (const b of bots) if (b.roleId) usage[b.roleId.toHexString()] = (usage[b.roleId.toHexString()] ?? 0) + 1;
  return <RolesSettings roles={roles.map(toBotRole)} usage={usage} />;
}
