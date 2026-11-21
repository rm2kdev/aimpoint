import type { Metadata } from "next";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { cols } from "@/lib/db";
import { listMyPublicSubmissions, loadPublicProject, loadPublicTask } from "@/lib/project-public";
import { PUBLIC_UNAVAILABLE } from "@/lib/project-public-core";
import { projectPath, withTask } from "@/lib/paths";
import { loginHref, publicPageHref } from "./href";
import { PublicProjectScreen, PublicUnavailable } from "./public-project";

/**
 * Public project page (VEC-257): `/p/<org>/<KEY>`, outside the member-only /o shell, works signed out. Shows only
 * what lib/project-public.ts's loaders return (sanitised tasks, statuses, comments when the project shows them).
 * Query: `?task=KEY` one ticket, `?view=mine` the signed-in account's own submissions, `?submit=1` the submit form
 * (signed-out visitors are sent to sign in and back), `?created=KEY` highlights a ticket just submitted.
 * Private, unknown and archived projects are a plain 404; an unpaid (locked) org's project shows only "unavailable".
 */
export const dynamic = "force-dynamic";

const loadProject = cache((slug: string, key: string) => loadPublicProject(slug, key));
const loadTask = cache((slug: string, key: string, task: string) => loadPublicTask(slug, key, task));

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

export async function generateMetadata({ params, searchParams }: PageProps<"/p/[org]/[key]">): Promise<Metadata> {
  const [{ org, key }, sp] = await Promise.all([params, searchParams]);
  const res = await loadProject(org, key);
  if (!res) return { title: "Page not found" };
  if (!res.available) return { title: "Unavailable" };
  const { view } = res;
  const taskKey = one(sp.task);
  if (taskKey) {
    const t = await loadTask(org, key, taskKey);
    if (t?.available) return { title: `${t.task.key}: ${t.task.title}`, description: `${t.task.key} in ${view.project.name}, a public project of ${view.org.name}.` };
  }
  return {
    title: `${view.project.name} · ${view.org.name}`,
    description: `Public tickets of ${view.project.name} (${view.project.key}) by ${view.org.name}.${view.submitStatuses.length ? " Sign in to submit a ticket." : ""}`,
  };
}

/** Whether the signed-in account belongs to the org, so the page can offer a link into the app. */
async function isMember(userId: import("mongodb").ObjectId, slug: string) {
  const c = await cols();
  const org = await c.orgs.findOne({ slug: slug.trim().toLowerCase() }, { projection: { _id: 1 } });
  if (!org) return false;
  return !!(await c.memberships.findOne({ orgId: org._id, userId }, { projection: { _id: 1 } }));
}

export default async function PublicProjectPage({ params, searchParams }: PageProps<"/p/[org]/[key]">) {
  const [{ org, key }, sp] = await Promise.all([params, searchParams]);
  const res = await loadProject(org, key);
  if (!res) notFound();
  if (!res.available) return <PublicUnavailable message={PUBLIC_UNAVAILABLE} />;
  const { view } = res;
  const slug = view.org.slug;
  const pkey = view.project.key;
  const taskKey = one(sp.task)?.trim().toUpperCase();
  const mineView = one(sp.view) === "mine";
  const submitting = one(sp.submit) === "1";

  const user = await currentUser();
  // Sign-in-only views send signed-out visitors to sign in and straight back here.
  if (!user && (mineView || submitting)) redirect(loginHref(publicPageHref(slug, pkey, { view: mineView ? "mine" : null, submit: submitting })));

  const [detail, mine, member] = await Promise.all([
    taskKey ? loadTask(org, key, taskKey) : null,
    user && mineView ? listMyPublicSubmissions(user, org, key) : null,
    user ? isMember(user._id, slug) : false,
  ]);
  if (taskKey && (!detail || !detail.available)) notFound();

  const appHref = member ? (taskKey ? withTask(projectPath(slug, pkey), taskKey) : projectPath(slug, pkey)) : null;
  return (
    <PublicProjectScreen
      view={view}
      me={user ? { name: user.name || user.email.split("@")[0] } : null}
      appHref={appHref}
      mode={detail?.available ? "task" : submitting && view.submitStatuses.length ? "submit" : mineView ? "mine" : "all"}
      detail={detail?.available ? { task: detail.task, comments: detail.comments } : null}
      mine={mine}
      created={one(sp.created) ?? null}
    />
  );
}
