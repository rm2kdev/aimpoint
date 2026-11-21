# Changelog ("What's new")

When someone signs in after a release, a "What's new" pop-up shows the latest milestone: a title, an optional
summary and a few entries, each with a short Markdown body and an optional screenshot they can scroll through,
then dismiss. Milestones are product-level: every organisation gets the same release, so they live in the repo
and ship with the deploy that delivers them.

## Adding a milestone

1. Create `src/content/changelog/<id>.ts`, named after the milestone id:

   ```ts
   import type { ChangelogMilestone } from "@/lib/changelog-core";

   const milestone: ChangelogMilestone = {
     id: "2026-11-21",
     title: "Image lightbox and public stats",
     releasedAt: "2026-11-21T09:00:00+08:00",
     summary: "A sentence on what this release is about.", // optional
     entries: [
       {
         title: "Zoom into any image",
         body: "Click an image in a task to open it full size. **Scroll** to zoom, drag to pan.",
         image: { src: "/changelog/2026-11-21/lightbox.png", alt: "A task image opened full screen, zoomed in" },
       },
       { title: "Statistics badges", body: "Public projects can show open and done counts as README badges." },
     ],
   };
   export default milestone;
   ```

2. List it at the top of `MILESTONES` in `src/content/changelog/index.ts` (newest first):

   ```ts
   import m20261121 from "./2026-11-21";
   export const MILESTONES: readonly ChangelogMilestone[] = [m20261121];
   ```

3. Put its screenshots in `public/changelog/<id>/` and reference them as `/changelog/<id>/<file>`.
4. Run `pnpm test`. `src/lib/changelog-core.test.mjs` validates the shipped list, so a mistake fails the tests
   before it can reach anyone.

Rules the tests enforce (`validateMilestone` / `validateMilestones` in `src/lib/changelog-core.ts`):

- `id` is the release date `YYYY-MM-DD`, or `YYYY-MM-DD-slug` (lowercase, dashes) for a second release that day.
  Ids are unique and `releasedAt` starts with the id's date (write it with the `+08:00` offset), so id order is
  release order. Never rename or reuse an id once shipped: people's seen marker stores it.
- `releasedAt` is an ISO 8601 timestamp, `title` is non-empty, `summary` is either left out or non-empty.
- At least one entry; every entry has a `title` and a `body`.
- Images sit under `/changelog/<this milestone's id>/`, are png, jpg, webp, gif or avif, exist in `public/`, and
  have alt text describing what the screenshot shows.
- Every `<id>.ts` in the folder is listed in the index, which is newest first.

Keep bodies to a sentence or two of Markdown; the pop-up is a quick tour, not release notes.

## Screenshots

- Capture at 1440 x 900 (or a crop of the relevant panel), light theme, at 2x device pixel ratio, then resize to
  1600 px wide at most. Prefer `webp` (or an optimised `png`), and keep each file under about 300 KB.
- Use one aspect ratio across a milestone (16:10 suits full-window shots) so the pop-up doesn't jump in height
  while scrolling through it.
- Use demo data only: no real names, emails or keys.

## Who sees it

Each person has `UserDoc.changelogSeen`: the id of the newest milestone they dismissed (per person, not per org).

- The pop-up shows the newest milestone whose id sorts after `changelogSeen` and that was released after the
  account was created (`shouldShowChangelog(MILESTONES, user.changelogSeen, user.createdAt)`).
- Existing accounts have no marker, so they see the newest milestone once. Older unseen milestones are not
  queued up: dismissing the newest covers everything before it.
- New signups are stamped with the newest milestone at signup (`changelogSeenAtSignup`, in `signupAction`), and
  milestones released before `createdAt` never show, so a new account isn't greeted with old news.
- Dismissing calls the `dismissChangelog(milestoneId)` server action (`src/app/actions/changelog.ts`). It only
  moves the marker forward: dismissing twice, with an older id or with an unknown id changes nothing.

## Where the data flows

- `src/app/o/[org]/layout.tsx` computes `changelogFor(user)` from the user document it already loaded, and passes
  it to `OrgProvider` as `changelog`. It arrives with the app shell on every org page and costs no extra query or
  request when navigating.
- Client components read `const { changelog, dismissChangelog } = useOrg()`. `changelog` is the milestone to show
  (or null); `dismissChangelog()` hides it in the tab at once and saves the marker.
- Screenshots are plain static files. `/changelog` is excluded from the legacy `/:org` redirect in
  `next.config.ts`, which would otherwise send `/changelog/...` to `/o/changelog/...`.
