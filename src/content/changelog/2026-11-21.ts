// First "What's new" milestone (VEC-375): the release from Friday 20 to Saturday 21 November 2026, the same
// changes as the VEC-371 changelog. Screenshots come from a throwaway demo org (no real data).
import type { ChangelogMilestone } from "@/lib/changelog-core";

const milestone: ChangelogMilestone = {
  id: "2026-11-21",
  title: "Bot switches, images everywhere and public stats",
  releasedAt: "2026-11-21T10:30:00+08:00",
  summary: "Here's what changed this week. Scroll through to see each one, or dismiss this when you're done.",
  entries: [
    {
      title: "A status bar on every task",
      body:
        "Every task now shows where it stands at the top of the pane. On a flow you see its steps, who has it **now** " +
        "and who gets it **next**; otherwise you see the project's statuses in order.",
      image: {
        src: "/changelog/2026-11-21/status-bar.webp",
        alt: "A task pane with a status bar showing the flow steps Triage, Build, Review and Done, with Build as the current step and the next owner below it",
      },
    },
    {
      title: "Move a stuck task on",
      body:
        "If a bot finishes without passing a flow task on, the task is marked Stalled. Its creator or an admin can " +
        "now send it to the next step straight from the banner.",
      image: {
        src: "/changelog/2026-11-21/move-on.webp",
        alt: "A task pane with a red Stalled banner saying the bot finished but the flow never handed the task on to Review, with a Move to Review button",
      },
    },
    {
      title: "Turn bots off and on",
      body:
        "Admins can switch a bot off from its settings page without losing its tasks or history. While it's off, it " +
        "can't be assigned or use its key, and anything sent to it waits until it's back on.",
      image: {
        src: "/changelog/2026-11-21/bot-switch.webp",
        alt: "A bot's settings page with its Enabled switch turned off and a history of who turned it off and on",
      },
    },
    {
      title: "See images full size",
      body:
        "Open any image in a task to view it full screen. Zoom in, drag to look around, and use the arrow keys to " +
        "page through every image on the task.",
      image: {
        src: "/changelog/2026-11-21/lightbox.webp",
        alt: "A screenshot attached to a task opened full screen over a dark backdrop, with zoom controls, previous and next arrows and a 1 / 4 counter",
      },
    },
    {
      title: "Images in comments",
      body:
        "Paste, drop or attach images straight into a comment. They show as thumbnails in the thread and open in " +
        "the same full-size viewer.",
      image: {
        src: "/changelog/2026-11-21/comment-images.webp",
        alt: "A comment thread where one comment holds a screenshot thumbnail, above a comment box with an attach image button",
      },
    },
    {
      title: "Public stats and README badges",
      body:
        "Public projects can show their open, in progress and done counts. Settings gives you ready-made badges to " +
        "paste into a README.",
      image: {
        src: "/changelog/2026-11-21/public-stats.webp",
        alt: "A public project page whose header shows counts of open, in progress and done tasks",
      },
    },
    {
      title: "One form for new tasks",
      body:
        "The New task dialog, public Submit a ticket pages and project forms now share one form, with the same " +
        "limits and clear messages next to the field that needs fixing.",
      image: {
        src: "/changelog/2026-11-21/task-composer.webp",
        alt: "The New task dialog with a Give it a title message under the empty title, a description toolbar and pickers for status, assignee, priority, type and project",
      },
    },
  ],
};

export default milestone;
