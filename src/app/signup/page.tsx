import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { signupAction } from "@/app/actions/auth";
import { currentUser } from "@/lib/session";
import { safeNext } from "@/lib/safe-next";
import { billingOn } from "@/lib/billing";

export const metadata = { title: "Create account" };

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const { next, email } = await searchParams;
  if (await currentUser()) redirect(safeNext(typeof next === "string" ? next : null));
  return <AuthForm mode="signup" action={signupAction} next={typeof next === "string" ? next : undefined} email={typeof email === "string" ? email : undefined} pricing={await billingOn()} />;
}
