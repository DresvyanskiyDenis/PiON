# `tasks` — the stale-task nudge

The task list itself — the `todo` tool, the `/todos` command, the live overlay, survival across
`/reload` and compaction — belongs to an adopted package. This module is the glue.

Configured by [`config/tasks.json`](../configuration/sessions.md#tasksjson).

## What the package does not do

!!! warning "A task list does not survive into a brand-new session"
    The package replays its state from the **session transcript** and writes nothing to disk. That
    is a deliberate design on its part and this module does not try to close the gap.

    If you need a plan to outlive a session, write it to a file. The task list is a working memory,
    not a record.

## What this module adds

1. **Binding to this repository's conventions.**
2. **A stale-`in_progress` nudge** every N turns, on a cached prefix — so it costs nothing in
   prompt-cache terms.

`nudgeEveryTurns` (6) and `staleAfterTurns` (12) are the two knobs. Lower the first when the agent
drifts from its plan; raise it when the reminders are eating context on short tasks.

## How it reads the list

Only through the persisted `todo` tool-result envelope — **never** through the package's internal
state module. Reaching into another package's internals makes its next minor release your problem.

Zero tasks is a documented no-op, so the module is inert rather than broken before the package's
tool exists.

## Related
[`tasks.json`](../configuration/sessions.md#tasksjson) · [jobs](jobs.md)
