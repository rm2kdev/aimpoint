"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { TaskComposer, usePendingUploads } from "@/components/task-composer";
import { LogoMark } from "@/components/logo";
import { PriorityIcon, ProjectDot, StatusRing, TypeTag } from "@/components/bits";
import { StatusTrackBar } from "@/components/status-track-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { submitPublicTicket } from "@/app/actions/project-public";
import { PRIORITY_LABELS, timeAgo } from "@/lib/format";
import { statusTrack } from "@/lib/status-track";
import { type PublicComment, type PublicProjectView, type PublicStatus, type PublicTask, type Status, type TaskType } from "@/lib/types";
import { cn } from "@/lib/utils";
import { loginHref, publicPageHref, signupHref } from "./href";
import { TASK_DESCRIPTION_MAX } from "@/lib/task-intake-core";

type Mode = "all" | "mine" | "task" | "submit";

export interface PublicProjectScreenProps {
  view: PublicProjectView;
  /** The signed-in account (any Aimpoint account), or null when signed out. */
  me: { name: string } | null;
  /** In-app link for members of the org; null for everyone else. */
  appHref: string | null;
  mode: Mode;
  detail: { task: PublicTask; comments: PublicComment[] | null } | null;
  /** The signed-in account's own submissions (only in the "mine" view). */
  mine: PublicTask[] | null;
  /** Key of a ticket just submitted, highlighted in the list. */
  created: string | null;
}

/** StatusRing takes the app's Status shape; the public one carries `stage` instead of `category`. */
const asStatus = (s: PublicStatus, order: number): Status => ({ id: s.id, projectId: "", name: s.name, color: s.color, category: s.stage, order });

const CLOSED = new Set(["done", "cancelled"]);

export function PublicProjectScreen(p: PublicProjectScreenProps) {
  const { view } = p;
  const slug = view.org.slug;
  const key = view.project.key;
  const statuses = useMemo(() => view.statuses.map(asStatus), [view.statuses]);
  const canSubmit = view.submitStatuses.length > 0;
  const here = publicPageHref(slug, key, { view: p.mode === "mine" ? "mine" : null, task: p.detail?.task.key });
  const submitHref = p.me ? publicPageHref(slug, key, { submit: true }) : loginHref(publicPageHref(slug, key, { submit: true }));

  return (
    <div className="min-h-full bg-sidebar pb-[calc(2.5rem+env(safe-area-inset-bottom))]">
      <header className="border-b border-border bg-background pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-12 max-w-[880px] items-center gap-2 px-[calc(1rem+env(safe-area-inset-left))] sm:px-6">
          <LogoMark className="size-4 shrink-0" />
          <span className="truncate text-[13px] text-muted-foreground">{view.org.name}</span>
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {p.appHref && (
              <Button asChild size="sm" variant="outline" className="h-7 text-[12.5px]">
                <Link href={p.appHref} data-open-in-app>
                  Open in Aimpoint
                </Link>
              </Button>
            )}
            {p.me ? (
              <span className="hidden max-w-[180px] truncate text-[12.5px] text-faint sm:inline" title={`Signed in as ${p.me.name}`}>
                Signed in as {p.me.name}
              </span>
            ) : (
              <Link href={loginHref(here)} className="text-[12.5px] font-medium text-muted-foreground hover:text-foreground">
                Sign in
              </Link>
            )}
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-[880px] px-[calc(1rem+env(safe-area-inset-left))] pt-6 sm:px-6 sm:pt-8">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <ProjectDot color={view.project.color} className="size-2.5" />
              <h1 className="truncate text-[20px] font-semibold tracking-[-0.02em]">
                <Link href={publicPageHref(slug, key)} className="hover:underline-offset-4">
                  {view.project.name}
                </Link>
              </h1>
              <span className="font-mono text-[12px] text-faint">{key}</span>
            </div>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Public tickets{canSubmit ? ". Anyone with an Aimpoint account can submit one." : ". This project isn't taking new tickets."}
            </p>
            {view.stats && <StatsLine stats={view.stats} />}
          </div>
          {canSubmit && p.mode !== "submit" && (
            <Button asChild className="h-9" data-submit-ticket>
              <Link href={submitHref}>Submit a ticket</Link>
            </Button>
          )}
        </div>

        {p.mode !== "task" && p.mode !== "submit" && (
          <nav className="mt-6 flex gap-1 border-b border-border text-[13px]" aria-label="Views">
            <Tab href={publicPageHref(slug, key)} active={p.mode === "all"}>
              All tickets
            </Tab>
            {p.me ? (
              <Tab href={publicPageHref(slug, key, { view: "mine" })} active={p.mode === "mine"}>
                My submissions
              </Tab>
            ) : null}
          </nav>
        )}

        {p.created && p.mode !== "submit" && (
          <div role="status" className="mt-4 rounded-lg border border-border bg-background px-3.5 py-2.5 text-[13px]">
            Thanks, your ticket was submitted as{" "}
            <Link className="font-medium underline underline-offset-4" href={publicPageHref(slug, key, { task: p.created })}>
              {p.created}
            </Link>
            . The team will take it from here.
          </div>
        )}

        {p.mode === "task" && p.detail && (
          <TaskDetail slug={slug} projectKey={key} task={p.detail.task} comments={p.detail.comments} statuses={statuses} />
        )}
        {p.mode === "submit" && (
          <SubmitForm slug={slug} projectKey={key} submitStatuses={view.submitStatuses} statuses={statuses} />
        )}
        {p.mode === "all" && (
          <TaskList slug={slug} projectKey={key} tasks={view.tasks} statuses={statuses} created={p.created} truncated={view.truncated} empty="No tickets yet." />
        )}
        {p.mode === "mine" && (
          <TaskList
            slug={slug}
            projectKey={key}
            tasks={p.mine ?? []}
            statuses={statuses}
            created={p.created}
            truncated={false}
            empty={canSubmit ? "You haven't submitted any tickets here yet." : "You haven't submitted any tickets here."}
          />
        )}

        {!p.me && p.mode !== "task" && canSubmit && (
          <p className="mt-6 text-center text-[12.5px] text-faint">
            <Link className="underline underline-offset-4 hover:text-foreground" href={loginHref(publicPageHref(slug, key, { submit: true }))}>
              Sign in
            </Link>{" "}
            or{" "}
            <Link className="underline underline-offset-4 hover:text-foreground" href={signupHref(publicPageHref(slug, key, { submit: true }))}>
              create a free account
            </Link>{" "}
            to submit a ticket.
          </p>
        )}
        <p className="mt-8 flex items-center justify-center gap-1.5 text-[12px] text-faint">
          <LogoMark className="size-3.5" /> Powered by Aimpoint
        </p>
      </main>
    </div>
  );
}

function Tab({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "-mb-px border-b-2 px-2.5 pb-2 font-medium transition-colors",
        active ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}

/* ---------------- list ---------------- */

function TaskList({
  slug,
  projectKey,
  tasks,
  statuses,
  created,
  truncated,
  empty,
}: {
  slug: string;
  projectKey: string;
  tasks: PublicTask[];
  statuses: Status[];
  created: string | null;
  truncated: boolean;
  empty: string;
}) {
  const [query, setQuery] = useState("");
  // "open" = everything not done or cancelled; otherwise one status id, or "" for all.
  const [filter, setFilter] = useState<string>("");
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) if (t.status) m.set(t.status.id, (m.get(t.status.id) ?? 0) + 1);
    return m;
  }, [tasks]);
  const openCount = tasks.filter((t) => !CLOSED.has(t.status?.stage ?? "")).length;
  const q = query.trim().toLowerCase();
  const shown = tasks.filter((t) => {
    if (filter === "open" && CLOSED.has(t.status?.stage ?? "")) return false;
    if (filter && filter !== "open" && t.status?.id !== filter) return false;
    if (q && !t.title.toLowerCase().includes(q) && !t.key.toLowerCase().includes(q)) return false;
    return true;
  });
  const statusById = new Map(statuses.map((s) => [s.id, s]));

  if (!tasks.length) return <p className="mt-10 text-center text-[13.5px] text-muted-foreground">{empty}</p>;
  return (
    <>
      <div className="mt-4 grid gap-3">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tickets"
          aria-label="Search tickets"
          className="h-9 bg-background"
        />
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 [scrollbar-width:none]" role="group" aria-label="Filter by status">
          <FilterChip active={filter === ""} onClick={() => setFilter("")} label="All" count={tasks.length} />
          <FilterChip active={filter === "open"} onClick={() => setFilter("open")} label="Open" count={openCount} />
          {statuses
            .filter((s) => counts.has(s.id))
            .map((s) => (
              <FilterChip key={s.id} active={filter === s.id} onClick={() => setFilter(s.id)} label={s.name} count={counts.get(s.id) ?? 0}>
                <StatusRing status={s} statuses={statuses} size={13} />
              </FilterChip>
            ))}
        </div>
      </div>
      <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-background" data-public-list>
        {shown.map((t) => (
          <li key={t.key} data-task-key={t.key} className={cn(created === t.key && "bg-chip")}>
            <Link href={publicPageHref(slug, projectKey, { task: t.key })} className="flex min-h-11 items-center gap-2.5 px-3.5 py-2.5 hover:bg-chip/60">
              <StatusRing status={t.status ? statusById.get(t.status.id) : undefined} statuses={statuses} size={16} />
              <span className="w-[68px] shrink-0 font-mono text-[12px] text-faint">{t.key}</span>
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{t.title}</span>
              <TypeTag type={t.type} className="hidden sm:inline-flex" />
              <span className="hidden w-14 shrink-0 text-right text-[12px] text-faint sm:block" suppressHydrationWarning>
                {timeAgo(t.updatedAt)}
              </span>
            </Link>
          </li>
        ))}
        {!shown.length && <li className="px-3.5 py-6 text-center text-[13px] text-muted-foreground">No tickets match.</li>}
      </ul>
      {truncated && <p className="mt-2 text-[12px] text-faint">Showing the {tasks.length} most recently updated tickets.</p>}
    </>
  );
}

function FilterChip({ active, onClick, label, count, children }: { active: boolean; onClick: () => void; label: string; count: number; children?: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] transition-colors",
        active ? "border-foreground/60 bg-background text-foreground" : "border-border text-muted-foreground hover:bg-background hover:text-foreground",
      )}
    >
      {children}
      {label}
      <span className="tabular-nums text-faint">{count}</span>
    </button>
  );
}

/* ---------------- detail ---------------- */

function TaskDetail({
  slug,
  projectKey,
  task,
  comments,
  statuses,
}: {
  slug: string;
  projectKey: string;
  task: PublicTask;
  comments: PublicComment[] | null;
  statuses: Status[];
}) {
  return (
    <article className="mt-6" data-public-task={task.key}>
      <Link href={publicPageHref(slug, projectKey)} className="text-[12.5px] text-muted-foreground hover:text-foreground">
        ← All tickets
      </Link>
      <div className="mt-3 rounded-xl border border-border bg-background p-5 sm:p-7">
        <p className="font-mono text-[12px] text-faint">{task.key}</p>
        <h2 className="mt-1 text-[19px] leading-snug font-semibold tracking-[-0.015em] break-words">{task.title}</h2>
        {/* The task pane's status bar (VEC-330), read-only: the public view carries no flow, so the track is the
            project's statuses (statusTrack's no-flow fallback); no owners or step actions here. */}
        <StatusTrackBar track={statusTrack({ statuses, statusId: task.status?.id ?? "" })} className="mt-4" />
        <dl className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-muted-foreground">
          <div className="flex items-center">
            <dt className="sr-only">Type</dt>
            <dd>
              <TypeTag type={task.type} />
            </dd>
          </div>
          {task.priority > 0 && (
            <div className="flex items-center gap-1.5">
              <dt className="sr-only">Priority</dt>
              <PriorityIcon priority={task.priority} />
              <dd>{PRIORITY_LABELS[task.priority]}</dd>
            </div>
          )}
          <div>
            <dt className="sr-only">Opened</dt>
            <dd suppressHydrationWarning>Opened {timeAgo(task.createdAt)}</dd>
          </div>
          <div>
            <dt className="sr-only">Updated</dt>
            <dd suppressHydrationWarning>Updated {timeAgo(task.updatedAt)}</dd>
          </div>
        </dl>
        {task.description.trim() ? (
          // Sanitised server-side by the public loader (publicSanitize + public image URLs).
          <div className="prose-aimpoint mt-5 max-w-none border-t border-border pt-5 text-[14px] break-words" dangerouslySetInnerHTML={{ __html: task.description }} />
        ) : (
          <p className="mt-5 border-t border-border pt-5 text-[13.5px] text-faint">No description.</p>
        )}
      </div>
      {comments && (
        <section className="mt-6" aria-label="Comments">
          <h3 className="text-[13px] font-semibold">
            Comments <span className="font-normal text-faint">{comments.length}</span>
          </h3>
          {comments.length ? (
            <ol className="mt-3 grid gap-3">
              {comments.map((c, i) => (
                <li key={i} className="rounded-xl border border-border bg-background px-4 py-3">
                  <p className="text-[12.5px]">
                    <span className="font-medium">{c.author}</span>{" "}
                    <span className="text-faint" suppressHydrationWarning>
                      {timeAgo(c.createdAt)}
                    </span>
                  </p>
                  <p className="mt-1 text-[13.5px] whitespace-pre-wrap break-words">{c.body}</p>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-[13px] text-muted-foreground">No comments yet.</p>
          )}
        </section>
      )}
    </article>
  );
}

/* ---------------- submit ---------------- */

/** The ticket form, on the shared TaskComposer (VEC-358): images go through this project's pending uploads. */
function SubmitForm({ slug, projectKey, submitStatuses, statuses }: { slug: string; projectKey: string; submitStatuses: PublicStatus[]; statuses: Status[] }) {
  const router = useRouter();
  const [type, setType] = useState<TaskType>("issue");
  const [statusId, setStatusId] = useState(submitStatuses[0]?.id ?? "");
  const [signedOut, setSignedOut] = useState(false);
  const uploads = usePendingUploads(`/api/public/${encodeURIComponent(slug)}/${encodeURIComponent(projectKey)}/uploads`);
  const again = loginHref(publicPageHref(slug, projectKey, { submit: true }));

  return (
    <section className="mt-6" aria-labelledby="submit-heading">
      <Link href={publicPageHref(slug, projectKey)} className="text-[12.5px] text-muted-foreground hover:text-foreground">
        ← All tickets
      </Link>
      <div className="mt-3 rounded-xl border border-border bg-background p-5 sm:p-7" data-public-submit>
        <h2 id="submit-heading" className="text-[17px] font-semibold tracking-[-0.015em]">
          Submit a ticket
        </h2>
        <p className="mt-1 text-[13px] text-muted-foreground">It goes straight to the team and shows up in this project&apos;s public list.</p>
        <TaskComposer
          layout="page"
          className="mt-5"
          upload={uploads.upload}
          descriptionMax={TASK_DESCRIPTION_MAX}
          descriptionPlaceholder="What happened, what you expected, steps to reproduce… Paste or drop screenshots."
          type={{ value: type, onChange: setType }}
          status={{ value: statusId, onChange: setStatusId, options: submitStatuses, statuses }}
          submitLabel="Submit ticket"
          pendingLabel="Submitting…"
          errorExtra={
            signedOut && (
              <>
                {" "}
                <Link className="underline underline-offset-4" href={again}>
                  Sign in again
                </Link>
              </>
            )
          }
          onSubmit={async (v) => {
            setSignedOut(false);
            const res = await submitPublicTicket(slug, projectKey, {
              title: v.title,
              description: uploads.resolve(v.description),
              type: v.type,
              statusId: submitStatuses.length > 1 ? (v.statusId ?? "") : "",
            });
            if (!res.ok) {
              setSignedOut(res.status === 401);
              return { ok: false, error: res.error };
            }
            uploads.reset();
            router.push(publicPageHref(slug, projectKey, { view: "mine", created: res.key }));
            router.refresh();
            return { ok: true };
          }}
        />
      </div>
    </section>
  );
}

/* ---------------- unavailable ---------------- */

/** Task counts under the project title (VEC-364), when the project shows statistics. */
function StatsLine({ stats }: { stats: NonNullable<PublicProjectView["stats"]> }) {
  const items: [string, number][] = [
    ["open", stats.open],
    ["in progress", stats.inProgress],
    ["done", stats.done],
    ["total", stats.total],
  ];
  return (
    <p data-public-stats className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] text-faint">
      {items.map(([label, n]) => (
        <span key={label}>
          <span className="font-medium text-muted-foreground tabular-nums">{n}</span> {label}
        </span>
      ))}
    </p>
  );
}

export function PublicUnavailable({ message }: { message: string }) {
  return (
    <main className="flex min-h-full flex-col items-center bg-sidebar px-[calc(1rem+env(safe-area-inset-left))] pt-[calc(2.5rem+env(safe-area-inset-top))] pb-[calc(2.5rem+env(safe-area-inset-bottom))] sm:justify-center">
      <div data-public-unavailable className="mx-auto w-full max-w-[520px] rounded-xl border border-border bg-background p-5 text-center shadow-sm sm:p-7">
        <h1 className="text-[15px] font-semibold">Page unavailable</h1>
        <p className="mt-1 text-[13.5px] text-muted-foreground">{message}</p>
      </div>
    </main>
  );
}
