# `jobs` — background work that outlives the session

Registers the `job` tool: start, poll, read, list, kill, prune.

## The gap it fills

Two faces of background work are already packaged and are **not** rebuilt here — the sub-agent
package's async runs (machine-readable lifecycle artifacts, a wait tool, a background-work
registry) and a background-tasks package's bash face (start, wait, logs, stdin, signals, terminate,
replay on reattach).

**Both are session-scoped.** Neither survives the `pi` process that started the work, and neither is
discoverable from a different session.

That gap is this module. A job store lives at `<state>/jobs/<id>/` outside the repository, and the
module publishes it into the packaged registries so the packaged faces can see our jobs too.

## When to reach for it

A build, a test suite, a long migration — anything whose runtime exceeds a bash timeout, or that you
want to start now and read the result of after a compaction, a `/reload`, or tomorrow.

The alternative is a bash call with a very long timeout, which holds the session hostage for the
duration and loses everything if the session ends.

## How you hear that it finished

A detached child is deliberately `unref()`d so it can outlive the `pi` process, which means
nothing observes its exit — the store is reconciled by whoever asks. So the extension polls while
any job is running, every two seconds, and stops polling the moment none is. An idle session pays
nothing for a watcher it does not need.

How the notice reaches you depends on what the session is doing:

| Session state | Delivery |
| --- | --- |
| An agent run is in flight | Queued for the next turn, so the notice does not steer the turn already running |
| Idle | Rendered straight away |

It never starts a turn by itself. A finished job is news, not an instruction, and waking the model
unprompted spends tokens you did not ask to spend — `job(action="output")` is one call away when
you want the log.

`state.json`'s `finishedAt` is the process's real exit time, read from the `exit` file's mtime, not
the moment something got round to looking.

## Cost

One directory per job, on disk, until pruned. `session_start` auto-prunes finished jobs older than
`PI_JOBS_PRUNE_HOURS` (default 168, i.e. 7 days) on every session, so a store nobody remembers to
clean up does not grow without bound. `job prune` is still a real command for pruning by hand
sooner than that.

## Related
[bash](bash.md) · [big-results](big-results.md) · [teammates](teammates.md) ·
[Configuration layout](../getting-started/config-layout.md#runtime-state)
