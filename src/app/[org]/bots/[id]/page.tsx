import { redirect } from "next/navigation";

export default async function OldBot({ params }: PageProps<"/[org]/bots/[id]">) {
  const { org, id } = await params;
  redirect(`/${org}/settings/bots/${id}`);
}
