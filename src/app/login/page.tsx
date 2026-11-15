import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { loginAction } from "@/app/actions/auth";
import { currentUser } from "@/lib/session";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next, email, deleted } = await searchParams;
  if (await currentUser()) redirect(typeof next === "string" ? next : "/");
  return (
    <AuthForm
      mode="login"
      action={loginAction}
      next={typeof next === "string" ? next : undefined}
      email={typeof email === "string" ? email : undefined}
      notice={deleted === "1" ? "Your account was deleted. You've been signed out everywhere." : undefined}
    />
  );
}
