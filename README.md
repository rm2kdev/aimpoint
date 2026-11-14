# Vector

A small, calm task tracker for software teams: issues and feature requests, organised by organisation and project, live for everyone.

- Multi-user, multi-organisation, with **admin** / **member** roles
- **Projects** inside each organisation; task IDs use the project key (`WEB-12`)
- Per-organisation **custom statuses** (name, colour, stage, order)
- Assignment, priority, type (issue / feature request), comments and an activity feed
- **WYSIWYG** descriptions (Tiptap) with image upload by button, paste or drag and drop
- **Real-time**: lists, task details, comments and descriptions update live; rows a teammate changed stay highlighted until you've seen them
- Light, dark and system themes; keyboard first (`N` new task, `⌘K` search, `J`/`K` or arrows to move, `Esc` to close)

Stack: Next.js 16 (App Router, server actions), MongoDB, Auth.js (email + password), shadcn/ui + Tailwind 4, Tiptap.

## Run locally

Requirements: Node 20+, pnpm, a MongoDB server (any local `mongod` works; no replica set needed).

```bash
pnpm install
cp .env.example .env.local      # then set AUTH_SECRET (openssl rand -base64 32)
pnpm seed                       # optional: demo org "Northwind Labs"
pnpm dev
```

Seeded logins (password `vector-demo`): `ryan@demo.vector.dev` (admin), `jonah@demo.vector.dev` (admin), `mia@demo.vector.dev`, `sofia@demo.vector.dev`.

Locally, with no Pusher or Blob variables set:

- real-time runs over **Server-Sent Events** from an in-process event bus (`/api/realtime`)
- uploaded images are stored in `.data/uploads` and served only to members of the owning org via `/api/uploads/[name]`

## Deploy to Vercel

1. Create a MongoDB Atlas cluster and set `MONGODB_URI` / `MONGODB_DB`.
2. Set `AUTH_SECRET`.
3. **Real-time:** create a Pusher Channels app (or a Pusher-compatible service such as Soketi) and set `PUSHER_APP_ID`, `PUSHER_SECRET`, `NEXT_PUBLIC_PUSHER_KEY`, `NEXT_PUBLIC_PUSHER_CLUSTER`. Clients subscribe to `private-org-<orgId>`; `/api/realtime/pusher-auth` only authorises members of that org. (Serverless functions can't hold SSE connections or share an in-memory bus, so the local driver is dev-only.)
4. **Images:** add a Vercel Blob store to the project; Vercel injects `BLOB_READ_WRITE_TOKEN` and uploads switch to Blob automatically.

Drivers are picked from the environment at runtime: `src/lib/realtime/server.ts` and `src/lib/storage.ts`.

## Layout

```
src/
  auth.ts                     Auth.js config (credentials, JWT sessions)
  app/
    actions/                  server actions: auth, org (projects, statuses, members, invites), tasks
    api/realtime/             SSE stream (local) and Pusher channel auth (Vercel)
    api/uploads/              image upload + local file serving
    [org]/my | all | p/[key]  task views; ?task=WEB-12 opens the detail pane
    [org]/settings            general, projects, statuses, members & invites
    login | signup | onboarding | invite/[token]
  components/                 shell, sidebar, task list, task pane, editor, pickers
  lib/                        db, session/authorisation, data mappers, realtime + storage adapters
scripts/seed.mjs              demo data
```

Every query is scoped by the organisation resolved from the URL slug and checked against the signed-in user's membership (`src/lib/session.ts`). Admin-only actions pass `{ admin: true }`.

Task ownership: everyone in the organisation can read every task and comment on it, but only the task's **creator** or an **admin** can edit or delete it (enforced in `updateTask` / `deleteTask`, mirrored as a read-only pane in the UI).

## Notes

- Invite links are single-use, expire after 14 days and are shared by copying the link (no email sending yet).
- Comments are plain text; descriptions are sanitised HTML.
- Not built yet: email notifications, billing, presence avatars, drag-to-reorder within a status.
