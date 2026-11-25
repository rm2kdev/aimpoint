// Third "What's new" milestone (VEC-452): actions happen at once and the server work runs in the background
// (VEC-453 to VEC-459). The demo gif was recorded side by side on a throwaway demo org under a throttled connection:
// the build before VEC-453 (8ad4df2) on the left, this release on the right.
import type { ChangelogMilestone } from "@/lib/changelog-core";

const milestone: ChangelogMilestone = {
  id: "2026-11-25",
  title: "Everything happens instantly",
  releasedAt: "2026-11-25T09:46:00+08:00",
  summary: "Aimpoint no longer makes you wait for the server. What you do shows straight away, and the saving happens behind the scenes.",
  entries: [
    {
      title: "Comments and images appear at once",
      body:
        "Press **Comment** and your comment is in the thread straight away, ready for the next one. Images show the " +
        "moment you add them, and you can send before they finish uploading: they're stored in the background.",
      image: {
        src: "/changelog/2026-11-25/instant-comments.gif",
        alt: "Side by side on a slow connection: before, the comment box says Uploading and then Sending while the comment waits to appear; now, the comment with its pricing mockup image shows in the thread at once and finishes sending in the background",
      },
    },
    {
      title: "Edits, new tasks and opening a task are instant too",
      body:
        "Changing a status, priority, assignee or title, creating or deleting a task, and pasting images into a " +
        "description or plan all show at once. Opening a task, or moving between tasks with **J** and **K**, no " +
        "longer waits on the network either.",
    },
    {
      title: "Nothing gets lost",
      body:
        "If something can't reach the server, Aimpoint keeps trying. If it still can't, it's marked **Not sent** with " +
        "**Retry** and **Discard**, and it sends by itself when you're back online. Leaving the page warns you while " +
        "anything is still unsent.",
    },
  ],
};

export default milestone;
