# Bots at work: the spinning status ring and the bot tray

A task's status ring spins whenever a bot is running on that task, whatever woke it (VEC-380, VEC-381). That covers:

- **Assigned work**: the bot picked the task up (push hand-off or `check_for_work`), or a ready hand-off after its last
  dependency closed. These runs hold an in-progress claim and move the task to the project's first started status.
- **Mentions and replies**: a bot answering an @mention, including a bot that isn't the assignee (the triager, a
  reviewer bot, anyone asked a question) and a mention on a Done, Cancelled, stopped, parked or waiting task. A reply
  spins the ring but changes nothing else: the status stays put, the task doesn't become that bot's assigned work,
  and it doesn't feed Stalled or run follow-ups.
- **Close-outs**: the triager closing out an umbrella once the tasks it broke it into are done.
- **Triage**: a triage bot breaking a task down.

The ring stops when the run ends: the bot calls `complete_task` or `release_task`, a person stops its work, the
Hermes run finishes, or the bot goes quiet on the task (10 minutes with no call on it, 2 minutes after its reply).
A run that dies without ending cleanly clears on its own after at most 3 hours. A plain comment that mentions no bot
starts no run, so nothing spins.

## Where it shows

Every view that shows a task's ring follows it live, with no refresh: list rows, the open task pane (header and the
dependency rows), command menu search results, and the Work lists on member and bot settings pages. Hovering the
ring names the bots: "Hermes is working on this", "Hermes and Kev are working on this".

The **bot tray** at the bottom of the app lists every bot that is running somewhere. `2/3` is its claimed work
against its capacity (`maxTasks`). A bot running on a task without a claim (a reply, a close-out) shows that
task's key, for example `VEC-12` or `VEC-12 +1`; replies don't count towards capacity. The tooltip spells it out
("Hermes: working on 2 of 3 tasks, also running on VEC-12").

The task pane's "is on this but last posted ..." hint and the red Stalled chip only look at the assignee's claimed
work, so another bot replying on the task never changes them.

## How it's built

- `Task.workingBotIds` = bots with an in-progress `agentClaims` doc on the task (open tasks only) plus bots with a
  live `runMarks` doc (any task). Filled by `withWorkingBots` in `src/lib/data.ts` for every list and every
  `task.upsert` (`publish()` in `src/lib/realtime/server.ts`); a ring-only change is sent with `workingOnly: true`
  so lists skip the "teammate changed this" highlight but still apply the new `workingBotIds`.
- Run marks: `src/lib/run-marks.ts` (start/end/sweep), rules in `src/lib/run-marks-core.ts`.
- The tray: `loadBotWorkload` sends `{botId, active, replying}` in the `bots.workload` snapshot, recomputed after
  every task event. `replying` lists the keys of tasks with a live run mark the bot holds no claim on.
- Client: `TaskStatusRing` (`src/components/task-status-ring.tsx`), `useLiveTasks` (`src/components/live-tasks.tsx`)
  for fetched snapshots such as command menu results, `BotStatusTray` (`src/components/bot-status-tray.tsx`).
