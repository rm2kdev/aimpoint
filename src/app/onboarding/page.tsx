import { requireUser } from "@/lib/session";
import { billingOn } from "@/lib/billing";
import { OnboardingForm } from "./form";

export const metadata = { title: "New organisation" };

export default async function OnboardingPage() {
  const user = await requireUser();
  return <OnboardingForm firstName={user.name.split(" ")[0]} billing={await billingOn()} />;
}
