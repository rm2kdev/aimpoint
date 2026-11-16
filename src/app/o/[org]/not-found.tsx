import { OrgNotFoundMessage } from "@/components/not-found-message";

export const metadata = { title: "Page not found" };

/** 404 for notFound() thrown by pages and nested layouts inside an organisation, rendered in the app shell. */
export default function OrgNotFound() {
  return <OrgNotFoundMessage />;
}
