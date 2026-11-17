import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { findOpenForm } from "@/lib/project-forms";
import { FORM_BODY_MAX, FORM_TITLE_MAX, HONEYPOT_FIELD } from "@/lib/form-submit";
import { FORM_DESCRIPTION_MAX, FORM_SUBMITTER_EMAIL_MAX, FORM_SUBMITTER_NAME_MAX } from "@/lib/task-service";
import { PublicForm, type PublicFormProps } from "./public-form";

/**
 * Public page for a project's external form (VEC-207): `/f/<publicId>`, no account needed, embeddable in an
 * iframe (next.config sends `frame-ancestors *` for /f only). Shows only what the admin wrote for the form (its
 * name and intro) plus the fields; nothing about the org, project or other tasks. `?embed=1` drops the page
 * background and padding for iframes. Unknown, disabled and deleted forms are a plain 404.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/f/[publicId]">): Promise<Metadata> {
  const form = await findOpenForm((await params).publicId);
  return { title: form ? form.name : "Form not found", robots: { index: false, follow: false } };
}

const PLAIN_ERRORS: Record<string, string> = {
  rate: "Too many submissions from here. Try again in a few minutes.",
  size: "That was too much to send in one go. Shorten the description and try again.",
  input: "Something in the form wasn't right. Check the title and try again.",
};

export default async function FormPage({ params, searchParams }: PageProps<"/f/[publicId]">) {
  const [{ publicId }, sp] = await Promise.all([params, searchParams]);
  const form = await findOpenForm(publicId);
  if (!form) notFound();
  const props: PublicFormProps = {
    publicId: form.publicId,
    name: form.name,
    intro: form.intro ?? null,
    typeMode: form.typeMode,
    type: form.type,
    allowedTypes: form.typeMode === "choose" ? form.allowedTypes : [],
    embed: sp.embed === "1",
    sent: sp.sent === "1",
    error: typeof sp.error === "string" ? (PLAIN_ERRORS[sp.error] ?? null) : null,
    limits: {
      title: FORM_TITLE_MAX,
      description: FORM_DESCRIPTION_MAX,
      name: FORM_SUBMITTER_NAME_MAX,
      email: FORM_SUBMITTER_EMAIL_MAX,
      body: FORM_BODY_MAX,
    },
    honeypot: HONEYPOT_FIELD,
  };
  return <PublicForm {...props} />;
}
