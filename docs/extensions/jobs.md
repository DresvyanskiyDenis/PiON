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

## Cost

One directory per job, on disk, until pruned. `job prune` is a real command and worth running
occasionally.

## Related
[bash](bash.md) · [big-results](big-results.md) · [teammates](teammates.md) ·
[Configuration layout](../getting-started/config-layout.md#runtime-state)
