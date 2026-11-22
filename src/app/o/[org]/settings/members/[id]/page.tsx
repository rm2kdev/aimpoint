import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { requireOrgPage } from "@/lib/session";
import { cols } from "@/lib/db";
import { loadOpenAssigned, loadWorkStats } from "@/lib/data";
import { loadMemberBilling } from "@/lib/billing-summary";
import { MemberDetail } from "@/components/settings/members";

export async function generateMetadata({ params }: PageProps<"/o/[org]/settings/members/[id]">) {
  const { id } = await params;
  if (!ObjectId.isValid(id)) return { title: "Member" };
  const user = await (await cols()).users.findOne({ _id: new ObjectId(id) }, { projection: { name: 1 } });
  return { title: `${user?.name ?? "Member"} · Members` };
}

export default async function MemberPage({ params }: PageProps<"/o/[org]/settings/members/[id]">) {
  const { org: slug, id } = await params;
  const { org, isAdmin } = await requireOrgPage(slug);
  if (!ObjectId.isValid(id)) notFound();
  const c = await cols();
  const uid = new ObjectId(id);
  const [membership, user] = await Promise.all([c.memberships.findOne({ orgId: org._id, userId: uid }), c.users.findOne({ _id: uid })]);
  if (!membership || !user) notFound();
  const [work, assigned, memberBilling] = await Promise.all([
    loadWorkStats(org._id, [uid]),
    loadOpenAssigned(org._id, uid),
    // VEC-415: the remove dialog shows the new seat total (admins only; null with billing off).
    isAdmin ? c.memberships.find({ orgId: org._id }, { projection: { userId: 1 } }).toArray().then((ms) => loadMemberBilling(org, ms)) : null,
  ]);
  return (
    <MemberDetail
      key={id}
      member={{ id, name: user.name, email: user.email, role: membership.role, image: user.image ?? null }}
      stats={{ ...work[id], joinedAt: membership.createdAt.toISOString() }}
      assigned={assigned}
      memberBilling={memberBilling}
    />
  );
}
