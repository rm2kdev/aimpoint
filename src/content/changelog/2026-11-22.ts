// Second "What's new" milestone (VEC-435): everything user-facing since 2026-11-21 (VEC-373 to VEC-431, AIM-6/7).
// Copy from VEC-433, screenshots from VEC-434 (a throwaway demo org, no real data). Billing is left out: it only
// shows with billing on.
import type { ChangelogMilestone } from "@/lib/changelog-core";

const milestone: ChangelogMilestone = {
  id: "2026-11-22",
  title: "Sub-tasks, triage plans and bots you can see working",
  releasedAt: "2026-11-22T10:30:00+08:00",
  summary: "Here's what changed since the last update. Scroll through to see each one, or dismiss this when you're done.",
  entries: [
    {
      title: "Catch up on what's new",
      body:
        "New updates now open in a short tour like this one. Missed one? The **What's new** item in the sidebar shows " +
        "how many updates you haven't seen, and **All updates** lists every past release.",
      image: {
        src: "/changelog/2026-11-22/whats-new.webp",
        alt: "The What's new dialog showing the All updates list of past releases, each with a thumbnail, date and summary, beside a sidebar item with a 2 badge",
      },
    },
    {
      title: "Sub-tasks stay with their task",
      body:
        "Tasks broken into smaller pieces now keep them together. Lists fold sub-tasks under their parent with a 3/5 " +
        "done count, and each sub-task links back to the task it's part of. You can also filter a list by who created " +
        "it, people or bots.",
      image: {
        src: "/changelog/2026-11-22/subtasks-list.webp",
        alt: "A task list where a parent task is expanded to show its sub-tasks indented under it, with a 3/5 done progress chip and a Created by filter in the toolbar",
      },
    },
    {
      title: "Make any task a sub-task",
      body:
        "Use **Make sub-task of** from a task's menu to put it under another task, or **Add sub-task** to create a new " +
        "one or pull in an existing task. Change your mind with **Move to another task** or **Remove from**.",
      image: {
        src: "/changelog/2026-11-22/make-subtask.webp",
        alt: "A Make WEB-20 a sub-task of dialog searching for help, listing Launch the help centre and two of its sub-tasks marked goes under WEB-1",
      },
    },
    {
      title: "Parent tasks start when the work does",
      body:
        "When someone starts or finishes a sub-task, its parent moves out of Todo into In Progress on its own, so the " +
        "bigger task never looks untouched while work is under way.",
      image: {
        src: "/changelog/2026-11-22/parent-start.webp",
        alt: "A parent task's activity showing it moved from Todo to In Progress because one of its sub-tasks was started",
      },
    },
    {
      title: "Sub-tasks on public trackers",
      body:
        "Public tracker pages list people's requests with the follow-up work folded underneath. Open a request to see " +
        "its sub-tasks and progress, and search finds sub-tasks too.",
      image: {
        src: "/changelog/2026-11-22/public-subtasks.webp",
        alt: "A public project page where a request is expanded to show its sub-tasks with their statuses, and a 3/5 progress chip beside it",
      },
    },
    {
      title: "The triage plan sits apart from the report",
      body:
        "When a bot triages a task, its plan now goes in its own **Plan** section, and what the reporter wrote stays " +
        "untouched as the **Original report**. Every edit to either is kept in the activity, so you can view or restore " +
        "an earlier version.",
      image: {
        src: "/changelog/2026-11-22/triage-plan.webp",
        alt: "A task pane showing the reporter's Original report, with the triage bot's Plan in its own card below it and plan edits in the activity",
      },
    },
    {
      title: "See which bots are working",
      body:
        "A spinning ring on a task's status icon now shows whenever a bot is working on it, including when it's just " +
        "replying to a mention. It updates live in every list, the task pane and search, and the bot tray shows what " +
        "each bot is busy with.",
      image: {
        src: "/changelog/2026-11-22/bots-working.webp",
        alt: "A task list where a bot's sub-task has a spinning status ring, with the task pane saying Hermes is working on this and the bot tray listing each bot's work",
      },
    },
    {
      title: "Links that just work",
      body:
        "Web addresses in comments now turn into links. In a description you're editing, Cmd-click (Ctrl-click on " +
        "Windows) a link to open it, or click into it to open, edit or remove it.",
      image: {
        src: "/changelog/2026-11-22/links.webp",
        alt: "A task description where a link shows a small bubble with its address and edit and unlink buttons, above a comment where a web address shows as a link",
      },
    },
    {
      title: "Hear back when your request is done",
      body:
        "People who submit a ticket on a public board now get one email when it's done, with a link back to their " +
        "request. The submit form tells them so.",
      image: {
        src: "/changelog/2026-11-22/submit-email.webp",
        alt: "A public Submit a ticket form with a note under the submit button saying the submitter will be emailed when the ticket is done",
      },
    },
  ],
};

export default milestone;
