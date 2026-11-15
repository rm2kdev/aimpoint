import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { cols } from "@/lib/db";
import { orgPath } from "@/lib/paths";

export default async function Home() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const c = await cols();
  const m = await c.memberships.find({ userId: user._id }).sort({ createdAt: 1 }).limit(1).next();
  if (!m) redirect("/onboarding");
  const org = await c.orgs.findOne({ _id: m.orgId });
  redirect(org ? orgPath(org.slug, "my") : "/onboarding");
}
