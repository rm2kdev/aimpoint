# Project flows: bot hand-off pipelines (design, VEC-173)

Status: design, approved for build by VEC-172. Build tickets: VEC-174 (model + storage), VEC-175 (engine),
VEC-176 (bot API/MCP), VEC-177 (editor UI), VEC-178 (task UI), VEC-179 (E2E).

## 1. Goal

A project can say, in order, who handles a task at each point of its workflow: "triage bot, then developer
bot, then tester bot, then CI/CD bot, then Done", or "outreach bot, wait for the customer's reply, planning
bot, specification bot, a person signs off". When the owner of one step finishes, Vector moves the task to the
next step's status, assigns the next owner, and hands it over (wake-up for a bot, notification for a person)
with that step's instructions.

Every project can define its own flow. An org-level default flow applies to every project that has none.

Non-goals for v1: parallel steps (two owners at once), conditional branches beyond "forward / back to an
earlier step", per-task-type flows (see open questions), time-based automation other than wait reminders.

## 2. Concepts

- **Flow**: an ordered list of steps, stored once per org (the default) and optionally once per project
  (an override).
- **Step**: one stage of the pipeline: a status the task sits in, who owns it, what they should do, and what
  moves it on.
- **Flow position**: on each task, which step it is at (`task.flow.stepId`). The status alone can't say this,
  because several steps may share one status (a project with a single started status, or the construction
  example's bots all working "In Progress"), and pickup moves statuses within a step (Todo -> In Progress).

## 3. Data model

```ts
// New collection `flows`, unique index {orgId: 1, projectId: 1}. projectId null = the org default.
interface FlowDoc {
  _id: ObjectId;
  orgId: ObjectId;
  projectId: ObjectId | null;
  /** Bumped on every save; tasks record the version they were positioned against. */
  version: number;
  steps: FlowStep[];          // 1..20, order = pipeline order
  updatedAt: Date;
  updatedBy: ObjectId;
}

interface FlowStep {
  id: string;                 // stable nanoid(8); survives renames and reorders
  name: string;               // "Develop", "Awaiting reply" (1..60 chars)
  status: StepStatusRef;      // where the task sits during this step
  owner: StepOwner;
  /** Markdown, <= 4000 chars. Shown to the owner in the hand-off and in the task context. */
  instructions?: string;
  advance: "complete" | "wait" | "manual";
  /** Only for advance "wait". */
  wait?: { label: string; resolvers?: ObjectId[]; remindAfterDays?: number | null };
  /** Default true. A bot can't finish the task (done status) while a later required step remains. */
  required?: boolean;
  /** Optional jump instead of the next step in order (id of a later or earlier step). */
  next?: string | null;
}

type StepStatusRef =
  | { stage: StatusCategory; name?: string | null }   // org default: stage + optional preferred name
  | { statusId: ObjectId; stage: StatusCategory };    // project flow: exact status, stage kept as fallback

type StepOwner =
  | { kind: "bot"; id: ObjectId }
  | { kind: "person"; id: ObjectId }
  | { kind: "triage" }   // only on triage-stage steps: any bot whose role allows check_for_triage (today's behaviour)
  | { kind: "keep" }     // leave the current assignee (whoever triaged/assigned it decides)
  | { kind: "none" };    // unassign: a pool step anyone can pick up, or a pure wait

// On TaskDoc (new, optional):
flow?: {
  stepId: string | null;      // null = detached (status matches no step); engine re-attaches on the next status change
  source: "project" | "org";  // which flow it was positioned against
  version: number;
  enteredAt: Date;
  /** A person assigned someone else during this step; the next advance applies flow owners again. */
  ownerOverride?: boolean;
  /** Someone switched the flow off for this task: Vector behaves exactly as without flows. */
  paused?: boolean;
  /** Wait steps: when a reminder was sent (once per entry). */
  remindedAt?: Date | null;
} | null;

// On ProjectDoc (new, optional): "inherit" (default, absent) | "custom" (has its own FlowDoc) | "off".
flowMode?: "inherit" | "custom" | "off";
```

### 3.1 How a step references a status

Statuses are per project (VEC-114), so:

- **Org default steps** store a **stage** plus an optional **preferred status name** (e.g. `{stage:
  "started", name: "In Review"}`). Resolution in a project: the status of that stage whose name matches
  (case-insensitive), else the first status of that stage by order. This mirrors `statusFor()` and the org
  default new-task stage (VEC-128).
- **Project steps** store the exact **statusId** (renames don't break them) plus its stage. If that status is
  deleted, the step falls back to `{stage, name}` resolution and the editor flags the step ("status deleted,
  using Testing").
- A step whose stage the project lacks (no started status, VEC-120) is **skipped** in that project; the editor
  lists those as "skipped in OPS, BLD".
- `cancelled` is never a step stage: cancelling is always allowed and leaves the flow. `done` steps are
  terminal (nothing after them). `backlog` steps are allowed (e.g. an "Icebox" holding step) but unusual.

### 3.2 Resolution order

`resolveFlow(orgId, projectId)`:

1. Project `flowMode: "off"` -> no flow (today's behaviour).
2. Project `flowMode: "custom"` and a FlowDoc for the project -> that flow.
3. Otherwise the org default FlowDoc (projectId null).
4. No org default (deleted or never seeded) -> no flow.

The result is a `ResolvedFlow` with every step's status resolved to a concrete StatusDoc of that project (or
dropped as skipped), cached per request. "Reset to default" = delete the project's FlowDoc and set
`flowMode: "inherit"`; tasks keep their step ids where the default has the same ids (it won't, generally), so
they re-attach by status (section 5.6).

Validation on save (both levels): 1..20 steps, unique ids, the last reachable step is a done-stage step, no
step after a done step, `next` points at an existing step, owners exist in the org (bots or members), triage
owner only on triage-stage steps, `wait` only with advance "wait", no two consecutive steps that are
identical (same status and same owner). Project flows: every statusId belongs to the project.

## 4. Default flow

Seeded once per org by a migration (and for new orgs at creation), editable by admins in Settings > Flows,
"Default flow". It is behaviour-preserving: an org that never touches it sees no change, because every owner
is "keep" or "triage" and the review step is optional.

| # | Step     | Status (stage, preferred name) | Owner    | Advance  | Required |
|---|----------|--------------------------------|----------|----------|----------|
| 1 | Triage   | triage, "Triage"               | triage   | complete | yes      |
| 2 | Build    | unstarted, "Todo"              | keep     | complete | yes      |
| 3 | Review   | started, "In Review"           | keep     | complete | no       |
| 4 | Done     | done, "Done"                   | none     | (end)    | yes      |

Admins then point step 2 at their dev bot and step 3 at their tester bot and make it required; that is the
"Triage -> Todo/dev bot -> In Review/tester -> Done" standard Ryan described. Projects inherit it until they
override; "Customise for this project" copies the resolved default into a project FlowDoc (statusIds filled
in) to edit; "Reset to default" deletes it.

## 5. Hand-off semantics (the engine, VEC-175)

All moves go through one function in a new `lib/flow-engine.ts`, called from the task service:

```ts
advanceFlow(actor, task, opts: { to?: stepId; reason: "complete" | "event" | "manual" | "back" | "sync" })
```

It runs inside `updateTaskAs` (one write, one `task.upsert`, normal activity, normal dependency
bookkeeping), so every invariant of the existing write path (claims, closeout, stalled notices, publish order,
VEC-111) still holds.

### 5.1 Entering a flow

- A task created without a status starts at the first step whose status it lands in (org new-task stage,
  VEC-128). Created with an explicit status: the first step with that status. No match: detached.
- The step's owner is applied unless the create call named an assignee (explicit beats flow).
- Existing tasks have no `flow` field; they are positioned lazily on their next status change or
  complete_task (section 8).

### 5.2 Advancing on complete

The step owner (bot: `complete_task`; person: "Complete step" in the task pane) finishes the step:

- `complete_task` **without** `status` on a flow task -> advance to the step's `next` (or the next step in
  order). This becomes the normal way for a bot to finish its part.
- `complete_task` **with** a status:
  - the status of a later step -> jump there (skipping steps in between is refused for a bot if a skipped
    step is required);
  - the status of an earlier step -> **send back** (e.g. the tester fails it back to Develop); the earlier
    step's owner gets it again with the comment as the hand-off note;
  - a done status while a later required step remains -> refused for bots with a UserError naming the step
    ("Review (Testing Verification) still has to run; call complete_task without a status to hand it on");
    people may always do it;
  - a cancelled status -> always allowed; leaves the flow.
- Advancing writes: `statusId` = next step's status, `assigneeId` = next owner (per `owner.kind`),
  `flow.stepId`/`enteredAt`/`version`, clears `ownerOverride`, and an activity `{kind: "flow_step", from:
  stepName, to: stepName, note: "advanced" | "back" | "skipped" | "synced" | "event"}`.
- Hand-over uses the existing paths: the assignee change goes through `resetClaimOnAssign` and
  `announceAssignment`, so the previous bot's claim is finished, the next bot gets a fresh claim, and the
  wake-up is queued through `wakeBots` -> `dispatchWake` (VEC-101) with a new reason kind `handoff`
  (`{taskId, taskKey, title, by, fromStep, toStep, note}`). A person owner gets an `assigned` notification
  whose detail names the step. When the next owner is the same bot (two steps in a row), the bot's done
  claim is dropped (as `reopenForHandOff` does) and it is woken again with the new step's instructions.
- Arriving at the done step closes the task: `finishClaimsOnClose`, `dependencyChanged` (releases
  dependents), close-out of umbrellas, all unchanged.

### 5.3 Dependencies and `waitingOn`

The flow never wakes anyone for a blocked task. Advancing a task that has open `waitingOn` still moves its
status and assignee (so the board shows where it will go next), but `announceAssignment` already skips the
bot wake while `waitingOn` is non-empty; the blocked -> ready transition (`handOffReady`) wakes the
**current step owner** with kind `ready`, now including the step and its instructions. VEC-107
(`ownUnownedBlockers`) is unchanged.

### 5.4 Claims and `markStartedByBot`

Pickup must not undo the step. New rule in `markStartedByBot`: on a flow task it only moves the task when
the current step's status is backlog/unstarted stage, and then to the step's **working status**: the first
started-stage status by order that is *not used by a later step*, else the first started status. On a step
whose status is already started-stage (In Review / tester, Deploying / CI), pickup leaves the status alone.
The status changes made by pickup are "within the step" and don't re-position it (5.6 ignores them).
`resumeOnMention` follows the same rule.

### 5.5 Triage and umbrellas

- A triage-stage step with owner `triage` = today's triage queue (`wakeTriage`, `check_for_triage`).
  With owner `bot` = a pinned triager: only that bot is woken and only it can take the triage claim
  (`wakeTriage(..., {only: botId})`; `check_for_triage` filters by the step owner).
- When the triager's complete_task moves the task out of Triage:
  - The task now has open dependencies (it was split into sub-tasks) -> it is an **umbrella**: the engine
    sets `flow.paused = true` with note "umbrella" and stops; the triager keeps close-out as today
    (`triagedBy`, `closeout`). Its sub-tasks each enter the flow by their own status (5.1), with any
    assignee the triager gave them winning over the step owner.
  - No dependencies (the triager decided it's one task) -> normal advance to the next step, unless the
    triager assigned it explicitly during the triage (explicit beats flow).
- Re-entering Triage (`enterTriage`) re-positions the task at the triage step and clears `paused`.

### 5.6 Manual edits by people (the flow must not fight them)

- **Status change only** -> sync: the flow re-positions to the step with that status, searching forward from
  the current step first, then backwards; the new step's owner is applied (dragging a card to In Review =
  "send to the tester"). No step has that status -> `stepId: null` (detached): no owner change, no wake-ups;
  it re-attaches on a later status change into a step status.
- **Status + assignee in one write** -> position syncs, the explicit assignee wins, `ownerOverride = true`.
- **Assignee change only** -> the step stays, `ownerOverride = true`; the flow assigns again on the next
  advance.
- **Pause flow** (task pane menu, creator/assignee/admin) -> `flow.paused = true`: complete_task, status and
  assignee changes behave exactly as without flows until resumed. Resuming re-syncs by status.
- Archive / restore, project move: a moved task re-resolves the destination project's flow and syncs by
  its mapped status (VEC-114 mapping).
- Bots changing status with `set_status` follow the same sync rules as people, except the "required step"
  refusal on done (5.2).

### 5.7 Wait states (the construction "waiting on a customer reply")

A step with `advance: "wait"` pauses the task until an outside event:

- It sits in its own status (e.g. "Awaiting reply", started stage) with owner `none`, the bot that will
  notice the event, or a person.
- Nobody is woken on entry if the owner is `none`; a bot owner is woken once with the wait instructions
  (e.g. "watch the thread, call advance_task when they reply") and its claim is marked done right after
  (it isn't "working" while waiting), so it is neither shown as working nor as "finished" Stalled.
- What moves it on, in this order of preference:
  1. A resolver bot (`wait.resolvers`, plus the step owner) calls the new MCP/REST `advance_task` with a
     comment ("Reply received from J. Smith: wants a quote for 2 bathrooms"). This is how an email-watching
     bot or a webhook integration signals the event; the bot does not need to be the assignee.
  2. A person clicks the step action in the task pane, labelled from `wait.label` ("Reply received").
  3. A person moves the status (sync, 5.6).
- `remindAfterDays`: if the task is still at the step after N days, one `waiting` notification goes to the
  step owner (person) or the task creator / admins, and the task row shows "Waiting 6d: Customer reply"
  (`flow.remindedAt` makes it once per entry). A wait step is never red Stalled.
  As built (VEC-182): `lib/wait-reminders.ts` sweeps every minute in the server process (`/api/cron/wait-reminders`
  on Vercel, `CRON_SECRET`); recipients are the step owner if a person, else the assignee if a person, else the
  creator if a person, else admins. Entering a step writes a fresh `task.flow` (new `enteredAt`, no `remindedAt`), so
  leaving and coming back re-arms it. Rows show "Waiting 6d: <label>" at any wait step (from `enteredAt`; label =
  `wait.label`, else the step name), stronger once past the reminder; the pane's Now line says the same.

### 5.8 Stalled detection

- A flow task whose step owner was resolved is not "finished" Stalled after complete_task, because the
  advance reassigns it. "finished" can still occur for paused/detached tasks (unchanged rule).
- New `stalled` cause: the step's owner no longer exists (bot deleted, person removed). The engine leaves the
  task unassigned and the existing `needs_owner` / `unassigned` rules apply; the reason text names the step
  ("Review has no owner: Testing Verification was removed"). Removing a bot or member also flags the flows
  that reference it (editor warning, admin notification).
- Wait steps are excluded from red Stalled (they are expected to sit); reminders cover them.

### 5.9 Retry / unstall (VEC-159)

`retryHandOff` re-sends the current step's hand-off (kind `handoff`, `retry: true`, same instructions) to the
current step owner. On a wait step there's nothing to retry: the action becomes "Remind" for a person owner
or is hidden. Any new claim/wake state the engine adds must be cleared there too (skill rule).

## 6. Bot API / MCP changes (VEC-176)

As built (`lib/flow-bot-view.ts` builds every JSON shape below; `lib/bot-api-tools.ts` runs MCP tools for REST).

- **Task context** (`buildTaskContext`: MCP get_task, check_for_work, wake-up payloads incl. the webhook `task`;
  REST `GET /api/v1/tasks/{key}` returns the same object as top-level `flow`):
  ```json
  "flow": {
    "source": "project", "version": 3, "active": true, "paused": false, "detached": false,
    "step": { "id": "develop", "name": "Develop", "status": "Todo", "stage": "unstarted",
              "owner": { "kind": "bot", "id": "…", "name": "Dev" }, "advance": "complete", "required": true,
              "instructions": "…", "wait": null, "next": null, "number": 1, "of": 4 },
    "next": { "id": "test", "name": "Test", "status": "In Review", "stage": "started", "owner": { "kind": "bot", "id": "…", "name": "Tester" } },
    "holder": "Dev",
    "howToFinish": "When your part is done, call complete_task without a status: that moves it to In Review and hands it to Tester …",
    "steps": [ { "id": "develop", "name": "Develop", "status": "Todo", "owner": "Dev", "current": true, "passed": false }, … ]
  }
  ```
  `flow` is null when the project has no flow. `active` false (the seeded default, or no owner/instructions on this
  step and the next) = the flow says nothing here: `next` is null and `howToFinish` says to finish with a status as
  usual. `paused` (triage umbrella) and `detached` (status is no step's) also say to finish as usual.
- **complete_task**: without `status` on an active flow it advances to the next step; the reply says where it went
  and who has it ("Moved to In Review for the Test step and handed to Tester"), and with an explicit status (or when
  nothing moved) it adds "It's in Done (the Done step of its flow), assigned to you." The description explains the
  flow case first, then keeps the "Done releases dependents, In Review only for a named person" guidance. On an
  **inactive** flow it moves nothing (VEC-176 gate in `advanceTarget`; before it, the default flow's optional
  Review step caught every finished task in In Review). On a wait step it moves nothing and points at advance_task.
- **advance_task** `{task, comment?}` (catalog group work, not opt-in; existing roles must switch it on): resolves a
  wait step for the step owner, its `wait.resolvers`, or the task's assignee/creator (`updateTaskAs` internal
  `flowResolver` skips the comment-only refusal for exactly that move). Comment first, then the move, so the next
  owner's hand-off sees it; the caller's in-progress claim is finished before the move. Other steps are refused
  ("hands it on with complete_task without a status"). REST `POST /api/v1/tasks/{key}/advance`.
- **Wake-up prompt / check_for_work**: unchanged from VEC-175 (`flowBriefing`), plus the wait text names advance_task.
- **get_workspace** (and check_for_triage's workspace): `projects[].flow` = the resolved flow (`source`, `version`,
  `active`, `steps` with owner/status/stage/instructions/advance/required/wait/next, `skipped`), and a `flows` note
  on how flows work. `SERVER_INSTRUCTIONS` carry the same rules.
- **REST**: `GET /api/v1/flows` (per project: `flowMode`, `flow`), `GET /api/v1/projects` (`flow` per project),
  `GET /api/v1/tasks/{key}` (`flow`), `POST /api/v1/tasks/{key}/complete` (= complete_task) and `/advance`
  (= advance_task), both answering `{message}` or `{error}` with 400/403/404. Editing flows stays admin-only in the UI.
- Webhook event `task.handoff` (and `retry: true` for retries), through the wake queue (VEC-175).

## 7. UI (VEC-177, VEC-178), briefly

- Settings > Flows (org tab): the default flow editor; a project's detail page gets a "Flow" row: Inherit
  (shows the resolved default read-only) / Custom (editor) / Off, with "Reset to default".
- Editor: ordered step list (drag to reorder), each row = name, status picker (project statuses, or stage +
  name for the default), owner picker (People / Bots / Any triage bot / Keep / Unassigned), advance mode,
  wait label + resolvers + reminder, required toggle, instructions (Markdown). Shows the in-flight task count
  per step; deleting a step with tasks on it asks where they go (like deleting a status).
- Task pane: a stepper under the header (done / current / upcoming), "Complete step" or the wait label
  button for the current owner, Pause/Resume flow in the menu; `flow_step` activity entries ("Hermes finished
  Develop; handed to Testing Verification for Test").
- List rows: the step name as a small chip when it differs from the status name, "Waiting 6d" for wait steps.

## 8. Migration

- `ensureIndexes`: `flows` unique `{orgId, projectId}`; tasks index `{orgId, "flow.stepId"}` for per-step
  counts. Create both on the live DB with a one-off script too (cached init, skill note).
- Migration `2026-11-default-flow` (recorded in `migrations`, runs once): insert the section 4 default for
  every org without one. New orgs get it at creation. Projects get no FlowDoc (they inherit).
- Tasks are not backfilled. A task without `flow` is positioned lazily by status on its next status change /
  complete_task / advance. Because the seeded default only uses `keep` / `triage` owners and an optional review
  step, existing bots that pass `status: "Done"` keep working unchanged.
- Flow edits while tasks are in flight: tasks keep their `stepId` if the step still exists; tasks on deleted
  steps are moved per the editor's choice, else re-synced by status. `version` lets the UI show "positioned
  against an older version" if needed (no behaviour depends on it in v1).

## 9. Ryan's examples in the model

### 9.1 Dev pipeline (project VEC, Custom flow)

Statuses: Backlog, Triage, Todo, In Progress, In Review, Deploying (started), Done, Cancelled.

| # | Step    | Status    | Owner                        | Advance  | Instructions (short)                                        |
|---|---------|-----------|------------------------------|----------|-------------------------------------------------------------|
| 1 | Triage  | Triage    | triage (any triage bot)      | complete | Split into dependency-ordered sub-tasks or pass it on whole |
| 2 | Develop | Todo      | bot Hermes                   | complete | Implement; tsc + lint; commit; then complete_task (no status) |
| 3 | Test    | In Review | bot Testing Verification     | complete | Verify each acceptance criterion; pass = complete_task; fail = complete_task status Todo with what failed |
| 4 | Deploy  | Deploying | bot CI/CD Bot                | complete | Build, deploy, smoke test; failure = back to Todo           |
| 5 | Done    | Done      | none                         | (end)    |                                                             |

Walk-through: Ryan files a request (Triage) -> triage bot claims it; single task -> Develop, assigned Hermes,
woken with step 2 instructions; pickup moves Todo -> In Progress (working status, not used by a later step) ->
Hermes `complete_task` (no status) -> In Review, assigned Testing Verification, woken; pickup leaves In Review
alone -> tester fails it: `complete_task status: "Todo"` -> back to Develop/Hermes with the failure comment ->
...passes -> Deploying/CI/CD Bot -> `complete_task` -> Done; dependents released. If the triage bot split it,
the umbrella is paused as an umbrella and each sub-task runs steps 2 to 5 (or is assigned explicitly by the
triager).

### 9.2 Construction pipeline (project BLD, Custom flow)

Statuses: Backlog, Triage, New lead (unstarted), Outreach, Awaiting reply, Planning, Specification,
Client sign-off (all started), Won (done), Lost (cancelled).

| # | Step           | Status          | Owner                 | Advance | Notes                                                                 |
|---|----------------|-----------------|-----------------------|---------|-----------------------------------------------------------------------|
| 1 | Outreach       | New lead        | bot Outreach Bot      | complete| Email the lead, put the thread id in a comment, complete_task        |
| 2 | Awaiting reply | Awaiting reply  | bot Outreach Bot      | wait    | label "Reply received", resolvers [Outreach Bot], remind after 5 days |
| 3 | Planning       | Planning        | bot Planning Bot      | complete| Draft the build plan from the reply                                   |
| 4 | Specification  | Specification   | bot Specification Bot | complete| Write the spec and quote                                              |
| 5 | Sign-off       | Client sign-off | person Sofia Ortega   | manual  | Review with the client; "Complete step" or move to Won                |
| 6 | Won            | Won             | none                  | (end)   |                                                                       |

Walk-through: a lead is created in New lead -> Outreach Bot woken, picks it up (New lead -> Outreach, the
working status), emails, `complete_task` -> Awaiting reply; Outreach Bot is told to watch the thread, its claim
is closed, nothing is red. The bot's mail integration sees the reply and calls `advance_task` with a summary
(or Sofia clicks "Reply received") -> Planning, Planning Bot woken -> `complete_task` -> Specification Bot ->
`complete_task` -> Sofia notified ("Sign-off is yours") -> she completes the step -> Won. No reply after 5
days -> one reminder to the creator/admins and a "Waiting 5d" chip; Lost (cancelled) is always available.

## 10. Edge cases checklist (for VEC-175 / VEC-179)

1. complete_task without status on a task with no flow -> today's behaviour (claim done, no move).
2. Advance onto a blocked task -> status/assignee move, no wake; ready later wakes the step owner once.
3. Same bot owns consecutive steps -> done claim dropped, re-woken with the new step's instructions.
4. Tester (started-stage step) picks up -> status stays In Review.
5. Person drags Todo -> In Review -> step syncs to Test, tester assigned and woken.
6. Person assigns someone else mid-step -> no reassign until the next advance.
7. Paused task -> flow ignored entirely.
8. Bot passes Done with a required later step -> refused with the step named; person may.
9. Cancel from any step -> leaves the flow, dependents released (cancelled counts as closed).
10. Step owner bot deleted -> task unassigned, needs_owner, flows flagged.
11. Project status deleted -> project step falls back by stage/name; editor flags it.
12. Project lacks a step's stage -> step skipped in that project.
13. Triage split -> umbrella paused, close-out unchanged; sub-tasks enter the flow.
14. Wait step: no red Stalled, one reminder per entry, advance_task by resolver, refused for others.
15. Retry on a step re-sends the same hand-off; on a wait step it is not offered.
16. Project move -> re-resolve the destination flow and sync.
17. Org default edited -> inheriting projects change at once; custom projects don't.
18. Existing tasks with no `flow` -> lazily positioned; no wake-ups from the migration itself.

## 11. Open questions (for Ryan)

1. Should the Northwind default flow ship pre-filled (Develop = Hermes, Test = Testing Verification,
   required), or stay behaviour-preserving (`keep` owners, optional review) until an admin edits it?
   The design assumes behaviour-preserving.
2. Should a person's status-only drag apply the step owner (assign the tester), as designed, or only move
   the status and leave the assignee?
3. Sub-tasks created by a triage bot: should they follow the project flow (designed: yes, explicit assignee
   wins), or only top-level tasks?
4. Per task type flows (e.g. bugs skip Triage), later or never?
5. Should bots be allowed to edit flows over the API (e.g. a setup bot), or admins in the UI only (designed:
   UI only in v1)?
