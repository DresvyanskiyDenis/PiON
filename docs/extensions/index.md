# Extensions

Thirty-four modules, composed into one PI extension by `extensions/index.ts`. Each exports `id` and
`register(pi)` and is imported in a fixed order — the order *is* part of the design, and
[Architecture](../concepts/architecture.md) explains why.

Every page here says what the module does, what configures it, and what it costs. Where a module's
behaviour rests on something measured against PI 0.84.0 rather than documented, the page says so.

## The six groups

| # | Group | Modules |
|---|---|---|
| 1 | Safety and identity | [guard](guard.md), [trust](trust.md), [session-context](session-context.md), [credentials](credentials.md), [cost-gate](cost-gate.md) |
| 2 | Capability configuration | [path-defaults](path-defaults.md), [tool-masks](tool-masks.md), [path-rules](path-rules.md), [skills-env](skills-env.md), [skill-mask](skill-mask.md), [skills-lint](skills-lint.md) |
| 3 | Tools and input | [ask-user](ask-user.md), [web](web.md), [bash](bash.md), [hooks](hooks.md), [input-transform](input-transform.md), [big-results](big-results.md) |
| 4 | Orchestration | [dispatch](dispatch.md), [teammates](teammates.md), [message-agent](message-agent.md), [worktree](worktree.md), [jobs](jobs.md), [tasks](tasks.md) |
| 5 | Observability and lifecycle | [quota](quota.md), [digest](digest.md), [compaction](compaction.md), [context-report](context-report.md), [context-imports](context-imports.md), [session-index](session-index.md), [auto-title](auto-title.md), [auto-update](auto-update.md), [skills-lint](skills-lint.md), [thinking-indicator](thinking-indicator.md) |
| 6 | Last | [doctor](doctor.md) |

## What they register

| Command | Module |
|---|---|
| `/doctor` | [doctor](doctor.md) |
| `/context` | [context-report](context-report.md) |
| `/agents` | [dispatch](dispatch.md) |
| `/compaction-status` | [compaction](compaction.md) |
| `/autocompact` | [compaction](compaction.md) |
| `/path-defaults-status` | [path-defaults](path-defaults.md) |
| `/quota` | [quota](quota.md) |
| `/teammates` | [teammates](teammates.md) |
| `/peers` | [message-agent](message-agent.md) |
| `/index` | [session-index](session-index.md) |
| `/ctx-dump` | [session-context](session-context.md) |
| `/jobs` | [jobs](jobs.md) |
| `/review` | [tool-masks](tool-masks.md) |
| `/explore` | [tool-masks](tool-masks.md) |
| `/ship` | [tool-masks](tool-masks.md) |

| Tool | Module |
|---|---|
| `ask_user` | [ask-user](ask-user.md) |
| `expand_result` | [big-results](big-results.md) |
| `job` | [jobs](jobs.md) |
| `message_agent` | [message-agent](message-agent.md) |
| `teammate` | [teammates](teammates.md) |
| `web_answer` | [web](web.md) |

Tools that come from adopted packages — `subagent`, `web_search`, `web_fetch`, `todo` — are listed
in `config/tools.declared.json`; see [Generated and locked files](../configuration/not-editable.md).

## The contract every module follows

- **`register()` starts no timers, sockets or watchers.** The factory also runs in invocations that
  never open a session, such as `pi --list-models`. All I/O belongs in `session_start` and is torn
  down in `session_shutdown`.
- **A `tool_call` handler declares its internal-error posture.** `guardedHandler` takes
  `onInternalError: "open" | "closed"`. `"open"` for our own guards — a bug in our code must not
  blanket-block every tool call. `"closed"` for [hooks](hooks.md), because a declarative rule that
  silently stops applying *is* the bug.
- **A module records both its load and its absence.** `extensions/lib/manifest.ts` keeps a registry
  so [`doctor`](doctor.md)'s `D-05` can tell "threw during registration" from "never attempted",
  and [`trust`](trust.md)'s deadman can block dangerous tools when a guardrail is missing.

## What is not here

There is no `extensions/failover.ts`. Provider failover was specified, scheduled and **cancelled**
— see [`onProviderError`](../configuration/routing.md#onprovidererror).
