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

Keep bodies to a sentence or two of Markdown; the pop-up is a quick scroll through the changes, not release notes.

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

## The pop-up

`src/components/whats-new-dialog.tsx` (VEC-374), mounted once in `AppShell`:

- `useWhatsNew()` opens it about 0.6 s after the first load of an org page when `useOrg().changelog` is set, once
  per tab, and waits while another dialog (search, new task) is open. The install banner is held back while the
  pop-up is open or about to open, so the two never show at once.
- A milestone is one vertically scrolling list (VEC-392, replacing the VEC-374 slide carousel): the header (title,
  date, summary, "All updates" link or "‹ All updates" back) and the footer (change count, "Got it") stay put, and
  every entry is stacked between them, top to bottom: screenshot (16:10 box, fitted, at most half the viewport
  tall), title, Markdown body (`markdownToHtml` + `prose-aimpoint`), in a centred column of up to 760 px. The list
  takes focus on open, so Arrow/Page Up/Down, Home/End and Space scroll it. The expand button (or a click on the
  screenshot) opens the ImageLightbox over all of the milestone's screenshots, and focus returns to that button.
- Size: on desktop a centred panel about 70% of the viewport (70vw wide, at least 600 px and at most 1120 px,
  78vh tall), never full screen; the All updates list keeps the width and grows only as tall as its rows. Phones
  (under 640 px) get a full-height sheet that scrolls the same way, screenshot above text.
- Close (X), Esc, the backdrop and "Got it" all close it the same way, which dismisses the
  milestone once. The provider hides it at once; a failed save shows a toast and doesn't reopen it (it may show
  again on the next load).
- The user menu's "What's new" entry reopens the newest milestone at any time. Opening it doesn't touch the seen
  marker; closing it dismisses only if it is the person's unseen milestone.
- Pure helpers (gallery, date line, history rows, index clamp) live in `src/lib/whats-new-core.ts`.

## All updates (history)

Every milestone can be reopened from a list inside the same dialog (VEC-377). It is a view of the pop-up, not a
page: the changelog is product-level and the dialog already carries the milestone view, so there is no
`/o/<org>/changelog` route to link to.

- Reach it from the sidebar's "What's new" item (VEC-384; under Settings, in the desktop sidebar and the phone
  drawer, absent until a milestone has shipped), the "All updates" link next to the release date in the pop-up's
  header, the user menu's "All updates" entry (under "What's new") and the command menu (Actions: "What's new",
  "All updates"). The sidebar item carries a small dot while the person has an unseen milestone; opening the list
  from it doesn't dismiss that milestone.
- Link to it with `?whats-new=all` on any org page (for example `/o/<org>/my?whats-new=all`), or to one milestone's
  tour with `?whats-new=<milestone id>`; an unknown id falls back to the list. The parameter is taken out of the
  address bar once the dialog opens (other parameters such as `?task=` stay), so reloading doesn't reopen it. The
  link follows the same rules as the menu entries: it counts as the tab's auto-open, and closing dismisses only when
  it showed the person's unseen milestone. `WhatsNewDeepLink` (in `whats-new-dialog.tsx`, mounted in AppShell) reads
  it; `parseWhatsNewParam` / `withoutWhatsNewParam` in `whats-new-core.ts` are tested.
- The list shows every milestone in `MILESTONES`, newest first (sorted with `sortMilestones`, whatever the index
  order): first screenshot as a thumbnail (a sparkles tile when there is none), title, release date, change count
  and the summary (or the entry titles). The newest is marked "Latest". With one milestone it is a one-row list, and
  the link still shows.
- A row opens that milestone's list of changes in the same dialog (`WhatsNewDialog` with `view="tour"`), with
  "‹ All updates" at the top to go back; focus returns to that row. Up/Down/Home/End move between rows.
- Browsing never moves the seen marker: only an opening that showed the person's unseen milestone dismisses on close
  (the auto pop-up, "What's new" while it is unseen, or picking the unseen one from the list). Opening the list or
  the menu also counts as this tab's auto-open, so the pop-up never re-triggers on top of it.
- State lives in `useWhatsNew()` (`view`, `fromHistory`, `showHistory`, `pickMilestone`, `openLink`; `openFromMenu` = the
  `OpenWhatsNewContext` value `{latest, history}`). Row data comes from `historyRows` in `src/lib/whats-new-core.ts`
  (tested in `whats-new-core.test.mjs`).

## Unseen count (sidebar badge)

The sidebar's What's new item can show how many milestones the person hasn't seen yet (VEC-388), so a release
doesn't hide behind a small dot.

- The count is `unseenMilestones(MILESTONES, user.changelogSeen, user.createdAt).length`: the same rule as the
  pop-up (milestones whose id sorts after the person's seen marker and that were released after the account was
  created), so it is per person, never per org. `changelogUnseenCount(user)` in `src/lib/changelog.ts` computes it.
- New signups are stamped at signup and see 0. An existing account with no marker counts every milestone released
  after it was created. It is 0 whenever there is no pop-up milestone.
- It clears when the person dismisses the pop-up milestone (closing the auto pop-up, or any opening that showed
  the unseen milestone, see above): the marker moves to the newest unseen milestone, and every older one sorts
  before it, so they all count as seen. In the tab it drops to 0 at once, before the save lands. Browsing the list
  or an older milestone doesn't clear it. A new release raises it again on the next page load (it ships with the
  deploy).
- Render it with `whatsNewBadge(count)` (`src/lib/whats-new-core.ts`): nothing for 0, "New" for 1, the number for
  2 to 9, "9+" above. `whatsNewBadgeLabel(count)` is the screen-reader text ("1 new update" / "N new updates",
  always the real number).
- What people see (VEC-389): `WhatsNewNavItem` in `src/components/sidebar.tsx` shows that text as a brand pill
  right-aligned on the What's new row, in the Inbox unread pill's style (18 px high, white on brand, numbers in
  mono). The label truncates before the pill does. The row's accessible name is "What's new, 1 new update" (the
  pill is `aria-hidden`, so it isn't read twice). Desktop sidebar and phone drawer read the same
  `useOrg().changelogUnseen`, so both clear together the moment the milestone is dismissed.
- Phones and tablets: the drawer is closed by default, so `MobileNavButton` in `src/components/app-shell.tsx`
  adds a small brand dot to the "Open navigation" button while the count is above 0 and names it "Open
  navigation, N new update(s) in What's new". It clears with the pill.
- No pulse or other motion: DESIGN.md keeps "nothing moves on its own" (its two exceptions are the working ring and
  the spring-loaded row), and the pill is visible enough without one.

## Where the data flows

- `src/app/o/[org]/layout.tsx` computes `changelogFor(user)` from the user document it already loaded, and passes
  it to `OrgProvider` as `changelog`. It arrives with the app shell on every org page and costs no extra query or
  request when navigating. `changelogUnseenCount(user)` goes along as `changelogUnseen` the same way.
- Client components read `const { changelog, changelogUnseen, dismissChangelog } = useOrg()`. `changelog` is the
  milestone to show (or null), `changelogUnseen` how many are unseen (0 when `changelog` is null);
  `dismissChangelog()` hides it in the tab at once, drops the count to 0 and saves the marker.
- Screenshots are plain static files. `/changelog` is excluded from the legacy `/:org` redirect in
  `next.config.ts`, which would otherwise send `/changelog/...` to `/o/changelog/...`.
