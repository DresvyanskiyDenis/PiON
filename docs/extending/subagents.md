# Adding sub-agents

A sub-agent is **one Markdown file with YAML frontmatter**. It runs in its own context window, on a
model you choose by tier, with a tool set you choose, and returns a report to the session that
dispatched it.

Thirteen ship in `agents/` — twelve specialists plus the `general-purpose` catch-all. Yours go in
`agents-private/` (git-ignored) or in a project's `.pi/agents/`.

---

## The 60-second version

```markdown
---
name: migration-writer
description: Use to write a database migration from a described schema change. Produces the
  migration file and its rollback, never applies either.
tools:
  - read
  - write
  - grep
  - find
model: light
returns: object
---

You write reversible database migrations. Never apply one.

## Working mode
1. Read the current schema from the migrations directory, not from memory.
2. Write the forward migration and its rollback in the same commit.
3. State explicitly what data loss the rollback causes, if any.

## Report format
- Files created.
- What the rollback loses.
- The command the human should run to apply it.
```

Save as `agents-private/migration-writer.md`. Restart `pi`. `/doctor`'s `D-03` confirms discovery.

---

## Frontmatter

Validated against a schema. A file that fails validation is registered as **invalid** and named in
the report — it is never silently skipped.

| Field | Required | Value |
|---|---|---|
| `name` | **yes** | `^[a-z][a-z0-9-]{1,63}$`, and it **must equal the filename** without `.md` |
| `description` | **yes** | ≥ 10 characters. This is the routing signal — see below |
| `model` | no | a tier name (`strong`, `light`, `confidential`) or an explicit `provider/model`. Omitted means `dispatch.json`'s `defaultTier`, which ships `strong` — so leaving it out is not a downgrade |
| `tools` | no | the tools this agent may use. **Honoured**, unlike a skill's `allowed-tools` |
| `isolation` | no | `none` (default) or `worktree` |
| `maxTurns` | no | integer 1–500 |
| `returns` | no | `text` or `object` |
| `mode` | no | `subagent` (default) or `teammate` |
| `delivery` | no | how a teammate must deliver its result |
| `skills` | no | scope the agent to named skills |
| `aliases` | no | alternative names it answers to |

Unknown keys are allowed and ignored — **with one exception**.

!!! danger "`fallbackModels` is refused"
    An agent file carrying it is marked invalid, by name. Per-agent model fallback is not a feature
    that was forgotten; it is one that was rejected. *A child that quietly answers from a weaker
    model is worse than a child that fails.*

    Same principle as [`onProviderError`](../configuration/routing.md#onprovidererror). Fail loud.

### `name` must match the filename

A mismatch is a validation problem, not a warning. Two names for one agent means the report, the
dispatch call and the file on disk can disagree, and the disagreement surfaces only when something is
already going wrong.

### Write the `description` for the dispatcher

It is what the parent session reads when choosing. Include the boundary, not only the capability:

```yaml
# weak
description: Reviews code.

# strong
description: Use for thorough review of a PR or committed branch — correctness, security,
  performance, test adequacy. Not for the current uncommitted diff; the main session handles
  pre-commit review itself. Read-only.
```

The shipped agents all follow the "Use for … Not for …" shape, and
`dispatch.json`'s `specialistMatchMinScore` scores a request against these descriptions before
falling back to a generic agent.

---

## Choosing a model

`model:` takes a **tier name**, not a model id, and that is the point. A tier is a semantic promise —
`strong` means "the main loop's model" — so an agent written on one machine works on another whose
`strong` is a different vendor entirely.

| Tier | Use for |
|---|---|
| `strong` | review, architecture, hard debugging — anything where being wrong is expensive |
| `light` | the opt-in tier for mechanical work: docs, multi-file edits, scaffolding, classification, summarising, grep-and-report |
| `confidential` | anything that must not leave your boundary. Ships unbound, so naming it fails loudly until you bind it |

An unresolvable tier, or a tier whose model nothing is currently serving, makes the agent
**restricted**: registered, visible, and refused **by name** when dispatched. Nothing degrades
silently.

See [Providers and tiers](../concepts/providers-and-tiers.md).

---

## Choosing tools

`tools:` is a real restriction — the sub-agent runtime honours it. This is the only place in the
harness where a declarative tool list actually constrains anything, which is why the answer to "I
want a skill that cannot write files" is *make it a sub-agent*.

A read-only agent:

```yaml
tools: [read, grep, find, bash]
```

!!! warning "`bash` in that list is not read-only"
    It is on the read-only agents that ship because investigation needs `git log`, `rg` and `ls`.
    The [guard](../configuration/guard.md) is what stops `bash` from doing damage, not the tool list.
    If you want a genuinely non-executing agent, drop `bash`.

---

## `isolation: worktree`

An agent that declares it runs in a fresh git worktree instead of your checkout.

If neither [`worktree`](../extensions/worktree.md) nor the package's own worktree support is
available, **the dispatch is refused**. It does not fall back to running in your checkout and saying
nothing — an agent that asked for isolation asked because running in the user's tree is unsafe.

Use it for mechanical multi-file work: migrations, codemods, dependency bumps.

---

## `returns: object`

The agent must return a structured report rather than prose. Four schemas ship in `config/schemas/`
(`code-review-report.ts`, `architect-review-report.ts`, `debug-report.ts`,
`security-review-report.ts`), and the reviewer agents reference them in their report sections.

Use `returns: object` when the parent needs to *act on* the result — count findings, gate a merge.
Use the default `text` when a human reads it.

---

## Where agents are discovered

`config/dispatch.json`'s `registryDirs`, in order:

```json
["<repo>/agents", "<repo>/agents-private", "<agentDir>/agents", "<cwd>/.pi/agents"]
```

| Directory | For |
|---|---|
| `<repo>/agents` | the thirteen that ship |
| `<repo>/agents-private` | **yours** — git-ignored |
| `<agentDir>/agents` | the PI agent directory |
| `<cwd>/.pi/agents` | project-specific agents, travelling with the repository |

A missing directory is a no-op — but only a *missing* one. A directory that exists and cannot be
read, or a file sitting where a directory belongs, is named at session start rather than quietly
contributing nothing. Full key reference:
[`config/dispatch.json`](../configuration/dispatch.md).

---

## Depth and concurrency

`maxDepth: 2` — a sub-agent may dispatch one further level and no more. Without a ceiling, a
recursive agent burns a quota in minutes and the transcript stops being readable.

`concurrencyDefault: 3` bounds how many run at once. Raise it only if your provider's
[per-provider concurrency](../configuration/routing.md#concurrency) can absorb it; a local model
server on `concurrency: 1` cannot.

---

## Concurrency limits — what each one actually bounds

`config/dispatch.json`'s `concurrencyDefault` is this repository's own dial. `pi-subagents` (the
runtime underneath it) carries a second, independent one: `globalConcurrencyLimit`. Left unset it
defaults to the package's own built-in ceiling of 20 (`DEFAULT_GLOBAL_CONCURRENCY_LIMIT`,
`src/runs/shared/parallel-utils.ts:128` in the pinned 0.41.0).

**It bounds children within one batch, not fan-out width across launches.** This is the part that is
easy to get backwards, so it is worth being precise about the mechanism rather than the number.

The semaphore is constructed **per execution**, at three separate sites — a background run
(`src/runs/background/subagent-runner.ts:1941`), a foreground run
(`src/runs/foreground/subagent-executor.ts:3381`, the path a plain dispatch actually takes), and a
chain step's `parallel: [...]` group (`src/runs/foreground/chain-execution.ts:749`). It is consumed
in exactly one place: the worker loop of `mapConcurrent` (`parallel-utils.ts:191` acquires,
`:195` releases), which walks the items of **one** batch.

`runs.all([...])` does not go through that loop. It validates its items and then `Promise.all`s N
independent host calls (`src/workflows/scripted-workflow.ts:70`). Each one reaches its own
`execute(randomUUID(), …)` as a single-child execution and builds its own semaphore, which it never
contends with. N launches, N semaphores, and nothing bounding N.

So the setting is real and still does something useful — it caps the children inside a single run's
parallel batch, and inside a chain step's `parallel:` group. What it does not do is cap how wide a
`runs.all` fan-out may open. The only ceiling on that path is a workflow's `usageBudget`, which is a
**cost** ceiling rather than a width one: the path is governed, just not on the dimension the
concurrency setting names. Measured on 2026-08-26 against 0.41.0: eight children dispatched, eight
ran concurrently, peak eight, no queueing. That this is accepted rather than overlooked is recorded
in [ADR 0005](../adr/0005-unbounded-fan-out-on-runs-all.md).

This repository ships the cap explicitly anyway, in `config/subagent.json` (generated at install
time from `config/subagent.default.json`, git-ignored like the rest of the personal config — see
[Generated vs tracked](../configuration/index.md#fact-2-generated-vs-tracked)):

```json
{
  "globalConcurrencyLimit": 4,
  "parallel": {
    "maxTasks": 8,
    "concurrency": 4
  }
}
```

`4` mirrors the `concurrency` this repository's own `routing.default.json` ships for its one bundled
provider — a conservative, obviously-safe number for a machine nobody has tuned yet, not a
measurement of any particular provider's real budget. **Raise it if your provider allows more**, and
keep it no higher than the tightest `concurrency` entry in
[`routing.json`](../configuration/routing.md#concurrency) that a batch could actually hit. Do not
treat it as protection against a wide `runs.all`; for that, keep the width in the script itself
inside the provider's budget, which is what the working rules in `AGENTS.md` ask a model to do.

`parallel.concurrency` is the same cap for the package's legacy top-level `tasks: [...]` dispatch
path; `parallel.maxTasks` bounds how many tasks a single call may *carry*, not how many run at
once, and is left at the package's own default. Installed at
`~/.pi/agent/extensions/subagent/config.json` — the one path `pi-subagents` reads its own config
from, and the one nested symlink the installer makes; see
[Configuration layout](../getting-started/config-layout.md).

---

## Verifying

```bash
pi
/doctor            # D-03: every agent name mentioned has a file
/agents            # the registry, including invalid and restricted entries
```

An agent that appears as **invalid** carries its reason. An agent that appears as **restricted**
resolved fine but names a model nothing is currently serving — usually an `optional` tier whose
backend is not running, or a tier bound to a provider you did not configure. Start the backend, or
bind the tier somewhere real.

(Before 2026-08-13 this status had a second cause: the agent's provider was classed looser than the
session. That rule was withdrawn — a class refuses nothing now, so it can no longer restrict an
agent. See [ADR 0004](../adr/0004-egress-classes-are-declarative.md).)

## Related

- [`dispatch`](../extensions/dispatch.md) · [`teammates`](../extensions/teammates.md) ·
  [`worktree`](../extensions/worktree.md)
- [`config/dispatch.json`](../configuration/dispatch.md) — every key
- [Providers and tiers](../concepts/providers-and-tiers.md)
