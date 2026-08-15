# `digest` — end-of-session summaries

Binds the session-teardown and pre-compaction events. On either, it spools one job file and asks a
detached helper to drain it — so summarisation never delays your exit.

Configured by [`config/digest.json`](../configuration/sessions.md#digestjson). One `light`-tier call
per qualifying session; output is plain Markdown in `~/.pi/agent/digests/`.

## Three overlapping recursion guards

The summariser is itself a `pi` invocation, which loads this same extension. Without guards it would
summarise its own summarisation, forever.

| Guard | Checked |
|---|---|
| A worker environment variable set by the spawner | at `register()` time, **before any handler is wired up** |
| The sub-agent name variable | a sub-agent turn is not a session a human digests |
| No session file (the summariser runs session-less) | even without the first two, there is nothing to spool |

Three independent guards for one failure, because the failure is a runaway loop that spends money.

## Turning it off

`"enabled": false`. One key.

If the cost is the concern rather than the files, rebind the `light` tier in
[`routing.json`](../configuration/routing.md) first — a digest on an appropriately cheap model is
close to free, and the summaries are the cheapest institutional memory this harness produces.

## Related
[`digest.json`](../configuration/sessions.md#digestjson) · [session-index](session-index.md) ·
[compaction](compaction.md)
