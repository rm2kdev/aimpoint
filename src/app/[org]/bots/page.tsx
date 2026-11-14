import { redirect } from "next/navigation";

export default async function OldBots({ params }: PageProps<"/[org]/bots">) {
  const { org } = await params;
  redirect(`/${org}/settings/bots`);
}
