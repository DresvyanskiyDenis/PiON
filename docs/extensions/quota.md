# `quota` — a pre-flight, not just a number

Registers `/quota`. Configured by [`config/quota.json`](../configuration/sessions.md#quotajson).

Only meaningful for a provider that publishes a usage endpoint.

## It warns. It never intercepts.

!!! danger "The pre-flight does not fail over"
    It warns before the turn and does nothing else. When the budget is actually gone, **the
    provider's own error surfaces unmodified** through the fail-loud path. This module never
    intercepts a provider call.

    That is the same standing rule as
    [`onProviderError`](../configuration/routing.md#onprovidererror), and it is why the failover
    item was cancelled rather than built.

## Three failure classes, three postures

| Surface | Posture |
|---|---|
| `session_start` / `turn_end` / `input` (the pre-flight) | Refresh runs inside a guard. **Any** exception, expected or not, is logged to stderr and swallowed — a bug in an optional quota display must never block a turn, let alone the session |
| `/quota` | An explicit user request. Expected failures (no token, unusable token, endpoint unavailable) render a specific, useful message; a genuinely unexpected error propagates **loudly** |

The asymmetry is the general contract in this tree: a lifecycle hook must never crash the session; a
command you just typed may surface a real error, because silence would read as success.

## The token

A **separate, read-only credential**, never the chat token. Stored `0600` at the path in
`quota.json`.

The guard's `SEC-QUOTA-TOKEN` rule denies any path ending `quota-token.json`, with no override — so
the agent cannot read the file even if asked directly.

A classic personal access token with a read-only user scope is required. A fine-grained token is
**rejected by the usage endpoint**, which is worth knowing before you spend twenty minutes creating
one.

## Related
[`quota.json`](../configuration/sessions.md#quotajson) · [credentials](credentials.md) ·
[Providers and tiers](../concepts/providers-and-tiers.md#fail-loud-no-failover)
