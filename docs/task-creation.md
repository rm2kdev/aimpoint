# Task creation: the three intake surfaces

Aimpoint creates tasks from three places. All three end in `createTaskAs` (`src/lib/task-service.ts`), which inserts
the task, writes the `created` activity, publishes `task.upsert`, enters the project's flow and hands Triage tasks to
the triage bots. What differs is what runs before it. This doc is the reference for VEC-355 (unify the three inputs):
VEC-356 built the shared server core, VEC-357/358 put the three client forms on one composer (`TaskComposer`).

| # | Surface | Who | Client | Server entry |
|---|---------|-----|--------|--------------|
| 1 | In-app **New task** dialog (also REST `POST /api/v1/tasks` and MCP `create_task`) | org members and bots | `components/new-task-dialog.tsx` on `TaskComposer layout="dialog"` | `createTask` action -> `createTaskAs` |
| 2 | **Public project** submit (`/p/<org>/<KEY>?submit=1`) | any signed-in Aimpoint account | `app/p/[org]/[key]/public-project.tsx` `SubmitForm` on `TaskComposer layout="page"` | `submitPublicTicket` -> `createTaskFromPublicProject` (`lib/project-public.ts`) |
| 3 | **Project form** (`/f/<publicId>`) | anyone, no account | `app/f/[publicId]/public-form.tsx` `PublicForm` on `TaskComposer layout="page"` | `POST /api/forms/<publicId>` -> `submitPublicForm` (`lib/form-submit.ts`) -> `createTaskFromForm` |

## Capability matrix before VEC-356

| | 1 In-app | 2 Public project | 3 Form |
|---|---|---|---|
| Title | required, max 300 (literal `300`) | required, max `PUBLIC_TITLE_MAX` 300 | required, max `FORM_TITLE_MAX` 300 |
| Title errors | "Give the task a title." / "Keep titles under 300 characters." | "Give it a title." / "Keep the title under 300 characters." | "Give it a title." / "Keep the title under 300 characters (it's N)." |
| Description | rich HTML, no text cap (`sanitizeDescription` cuts stored HTML at 200,000) | rich HTML, `FORM_DESCRIPTION_MAX` 10,000 text chars, 96 KB raw HTML | plain text (10,000) or rich HTML (form option `richText`, 10,000 text, 96 KB HTML); optional "hide description" |
| Description errors | none (non-text silently stringified) | "The description wasn't text. ..." + rich-prep errors | "Something in the form wasn't text. ..." + rich-prep errors; plain: "Keep the description under 10,000 characters (it's N)." |
| Sanitiser | `sanitizeDescription` (members keep code classes, image width/height, any http(s) image) | `prepareRichDescription` + `publicSanitize({allowImages:false})`, then `sanitizeDescription` | same as 2 with `allowImages` = form option, then `sanitizeDescription` |
| Images | yes: `POST /api/uploads` (session, 10 MB), any http(s) src kept | **no** (editor `images={false}`, server strips them) | form option `allowImages`: `POST /api/forms/<id>/uploads` (no session, 5 MB, sniffed type, max 10 per description), only the form's own pending uploads survive; screenshot custom fields use the same uploads |
| Type | any `TaskType`, unknown silently became `issue` | any `TaskType`, default `issue`, else "Pick one of the listed types." | `typeMode` fixed (form's type) or choose (`allowedTypes`); errors "Pick one of the listed types." (submit) and "Pick one of: a, b." (service) |
| Status | any of the project's own statuses (`requireProjectStatus`); default = project/org new-task stage for people, first not-started for bots | one of `publicAccess.submitStatusIds` (`pickSubmitStatus`), first = default; "This project isn't taking new tickets." / "Pick one of the listed statuses." | fixed `destinationStatusId` (re-checked by `requireFormDestination`), not chosen by the submitter |
| Other fields | assignee, priority, due date, dependencies | none | submitter name (100) / email (200, format check), custom fields (`form-fields-core.ts`) |
| Creator (`createdBy`) | the member or bot | the project id (synthetic, no edit rights) | the form id (synthetic) |
| Provenance (`source`) | none | `{kind:"public", userId, userName}`, activity note `public` | `{kind:"form", formId, formName, submitterName, submitterEmail}`, activity note `form` |
| Auth | org session / bot key | any signed-in account | none |
| Rate limits | none | 5 / account / project / 10 min, 60 / project / hour | 5 / IP / form / 10 min, 60 / form / hour; uploads 20 / IP / form / 10 min, 200 / form / hour |
| Honeypot | no | no | `website` field: looks like success, files nothing |
| Plan gate | no | `publicForms` | `publicForms` |
| Error transport | `{ok:false, error}` from `guard()` | `{ok:false, status 400/401/403/404/429, error, retryAfter?}` | JSON / 303 redirect with the same statuses + 413 |

## Unified target (VEC-356, server side)

One pure module, `src/lib/task-intake-core.ts` (no server-only imports, unit tested by `task-intake-core.test.mjs`),
owns the input rules every surface shares. The three server paths call it instead of their own copies.

- **Limits** (`INTAKE_LIMITS`, also exported one by one for clients): title 300 (`TASK_TITLE_MAX`), description
  10,000 text characters (`TASK_DESCRIPTION_MAX`), 96 KB raw rich HTML (`DESCRIPTION_HTML_MAX`), 10 images
  (`DESCRIPTION_IMAGES_MAX`), submitter name 100 (`SUBMITTER_NAME_MAX`), submitter email 200 (`SUBMITTER_EMAIL_MAX`).
  These are the only names: VEC-358 removed the old per-surface aliases (`PUBLIC_TITLE_MAX`, `FORM_TITLE_MAX`,
  `FORM_DESCRIPTION_MAX`, `FORM_SUBMITTER_*`, `FORM_HTML_MAX`, `FORM_IMAGES_MAX`) and `lib/form-rich-core.ts`.
- **Messages** (`INTAKE_ERRORS`): one text per failure, used by the server and importable by clients:
  - title: "Give it a title." / "Keep the title under 300 characters (it's N)."
  - description: "The description wasn't text. Reload the page and try again." / "Keep the description under 10,000
    characters (it's N)." / "That description has too much formatting to send (over 96 KB). ..." / "Add at most 10
    images (there are N)."
  - type: "Pick one of the listed types." status: "Pick one of the listed statuses." / "This project isn't taking new
    tickets."
  - submitter: "Keep your name under 100 characters." / "Keep your email under 200 characters." / "That email address
    doesn't look right."
- **Helpers**: `normalizeTitle(raw)`, `prepareDescription(raw, {rich, allowImages, imageAllowed})`,
  `resolveType(input, allowed, fallback)`, `resolveStatus(input, allowed)`. All return `{ok:true, ...} | {ok:false,
  error}`; the server wraps errors in `UserError`.
- **Sanitiser**: the public allow-list (`publicSanitize`, `htmlText`, `imageSources`, `stripMarkdownImages`) lives in the
  core too. `sanitizeDescription` stays the final pass for every surface inside `createTaskAs`.

Per surface after VEC-356:

| | 1 In-app | 2 Public project | 3 Form |
|---|---|---|---|
| Title | `normalizeTitle` | `normalizeTitle` | `normalizeTitle` (submit + service) |
| Description | non-string refused with the shared message; members' HTML through `sanitizeDescription` only, no 10,000 cap (see differences) | `prepareDescription({rich:true, allowImages:true, imageAllowed: own pending uploads})` | `prepareDescription` with the form's `richText`/`allowImages` and own pending uploads |
| Images | unchanged | **yes**: `POST /api/public/<org>/<KEY>/uploads` (signed-in account, same checks as forms) | unchanged |
| Type | `resolveType(type, TASK_TYPES, "issue")` (unknown is now refused, not rewritten; REST/MCP already refused) | `resolveType(type, TASK_TYPES, "issue")` | `resolveType(type, allowedTypes, form.type)` for choose forms; fixed forms ignore the input |
| Status | unchanged (`requireProjectStatus`, default rules) | `resolveStatus(statusId, submitStatusIds)` | `resolveStatus(null, [destination])` after `requireFormDestination` |

### Pending uploads, owner = form or public project

`formUploads` records carry an owner: `formId` (forms, unchanged) or `publicProjectId` + `userId` (public projects).
`lib/form-uploads.ts` exposes `pendingUploads(owner, urls)` / `claimUploads(owner, ids, taskId)` with
`owner = {kind:"form", id} | {kind:"public", id}`; `pendingFormUploads` / `claimFormUploads` stay as the form-owner
wrappers. The sweep removes unclaimed uploads of either owner after 24 h. Public project uploads:

- `POST /api/public/<org>/<KEY>/uploads` (multipart `file`), signed-in account required (401), project public and
  available (404 / 403 `PUBLIC_UNAVAILABLE`), body capped at 5 MB + headers (413), type sniffed (400, never SVG),
  rate limited per account per project (20 / 10 min) and per project (200 / hour) (429 + `Retry-After`). Answers `{url}`.
- On submit, only image sources that are this project's pending uploads **by the same account** survive; they are
  claimed by the new task. The public view serves them through the existing `/api/public/<org>/<KEY>/uploads/<file>`.
- Public projects take images whenever they are public (no separate switch): every submitter is a signed-in account
  and the uploads are rate limited. A per-project switch can be added to `publicAccess` later if a team asks.

### Differences kept on purpose

- **In-app description length**: members and bots write long specs (agents post multi-thousand-word descriptions), so
  the in-app path keeps no 10,000-character text cap; the stored HTML cap (200,000 in `sanitizeDescription`) still
  applies. The 10,000 cap protects the two public surfaces from anonymous or outside bulk.
- **In-app sanitiser**: members keep code-block language classes, image sizes and external image links; the public
  allow-list drops those. Both end in `sanitizeDescription`.
- **In-app status**: any of the project's statuses with the VEC-115 cross-project error text, checked in the database;
  public surfaces choose only among an admin-approved list.

### Channel rules (unchanged, stay with their surface)

Rate limits (`PUBLIC_RATE_LIMITS`, `RATE_LIMITS`, `UPLOAD_RATE_LIMITS`), the form honeypot (`HONEYPOT_FIELD`),
`source` provenance and activity notes, the synthetic creators (project id / form id), destination and submit-status
rules (`FORM_DESTINATION_STAGES`, `PUBLIC_SUBMIT_STAGES`), sign-in for public projects, and the `publicForms` plan gate.
Bad input is always refused before any rate limit is spent.

## Client: one composer (VEC-357/358)

`src/components/task-composer/` is the only task-creation form. `TaskComposer` owns what every surface shares; each
surface passes its extras as props/slots and keeps nothing of its own for title, description, type, errors or sending.

- **Shared parts**: title (required, 300), the description (`RichEditor`; uploads in flight are counted and sending waits
  for them), the type picker (all types or an allowed subset; one offered type shows none), the status picker (only
  with 2+ allowed statuses), inline field errors with `aria-describedby` and focus on the first invalid part, the
  page error summary ("One thing needs fixing before you send:"), the submit button with its pending text,
  Cmd/Ctrl+Enter, and the client checks. Limits and messages come from `task-intake-core.ts`; server refusals are
  mapped back onto the field they name by `serverFieldErrors` (`task-composer-core.ts`), anything else shows as the
  summary line (rate limits: the server's "Try again in N minutes" text).
- **Layouts**: `dialog` (in-app: borderless title, chip pickers, Cancel/Create footer, plain Enter in the title
  creates) and `page` (public: labelled fields, type cards "What is it?", status chips, a real `<form>` that can post
  without JavaScript via `action`, with a plain-text `<noscript>` fallback for the rich editor).
- **Words**: public surfaces call the types Bug report / Feature request / Task (`PUBLIC_TYPE_COPY`, also used by the
  External forms settings); the description is "Details", the picker "Status", submitter fields "Name"/"Email".
- **Images**: `usePendingUploads(endpoint)` (`pending-uploads.ts`) uploads to a pending-upload endpoint, shows an
  object-URL preview and swaps in the stored URL on send (`resolve`). Forms use `/api/forms/<publicId>/uploads`
  (editor and screenshot fields), public projects `/api/public/<org>/<KEY>/uploads`. The in-app dialog uses the org
  session upload (`/api/uploads`).

| | 1 In-app dialog | 2 Public project | 3 Form |
|---|---|---|---|
| Description | rich, images, no text cap | rich, images (pending uploads), 10,000 | `descriptionMode` rich (form `richText`) / plain textarea / none (`hideDescription`); images when `allowImages`; 10,000 |
| Type | chip, all types | cards, all types | cards when `typeMode` is choose (`allowedTypes`), none when fixed |
| Status | in the property row (any project status) | chips when the project allows 2+ submit statuses | none (fixed destination) |
| Extras (slots) | `properties`: project, status, assignee, priority, due date, dependencies | `errorExtra`: Sign in again on a 401 | `fields`: custom text + screenshot fields; `submitter` name/email (+ email help); `honeypot`; `initialError` from a no-JS redirect; `busy` while screenshot uploads run |
| After sending | toast, dialog closes | to My submissions with the new key highlighted | thank-you card, Send another |
| Surface-only | parked note, disabled bots | sign-in requirement, My submissions | embed height report (`aimpoint:form:height`), no-JS post |

Internal-only fields (assignee, priority, due date, dependencies) exist only in the in-app property row; the public
surfaces never render or send them.
