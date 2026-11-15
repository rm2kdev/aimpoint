import { requireOrgPage } from "@/lib/session";
import { loadNotifications } from "@/lib/notifications";
import { Inbox } from "@/components/inbox";

export const metadata = { title: "Inbox" };

export default async function InboxPage({ params }: PageProps<"/o/[org]/inbox">) {
  const { org: slug } = await params;
  const { org, user } = await requireOrgPage(slug);
  return <Inbox initial={await loadNotifications(org._id, user._id)} />;
}
