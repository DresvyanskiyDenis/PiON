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
runtime underneath it, pinned at 0.57.0) carries several of its own, and they bound different things.
Line references below are into that package's source.

### `globalConcurrencyLimit` — children inside one batch

Left unset it defaults to 20 (`DEFAULT_GLOBAL_CONCURRENCY_LIMIT`,
`src/runs/shared/parallel-utils.ts:137`). It is read into a semaphore built at exactly one place, in
`runSubagent()` (`src/runs/background/subagent-runner.ts:2452`), and consumed at exactly one place —
the worker loop of `mapConcurrent`, which acquires at `parallel-utils.ts:200` and releases at `:204`
while walking the items of **one** batch.

**It does not bound `runs.all` fan-out width.** `runs.all([...])` validates its items and then
launches N independent children, `Promise.all`-ing them (`src/workflows/scripted-workflow.ts:374`);
each becomes its own execution and never contends for that semaphore. Upstream states the same thing
in its own documentation: the setting "Caps simultaneously running children inside existing durable
legacy multi-child runs. New orchestration uses `workflowScript` and `runs.all`."

That this is accepted rather than overlooked — and what would reopen it — is recorded in
[ADR 0005](../adr/0005-unbounded-fan-out-on-runs-all.md).

A chain step's `parallel: [...]` group that names no `concurrency` of its own takes
`MAX_PARALLEL_CONCURRENCY = 4` (`parallel-utils.ts:265`), not `globalConcurrencyLimit`.

### The three spawn budgets — cumulative spend, not width

New in 0.57.0. Only the first has a default — the other two do nothing until you set them.
This table previously gave `100` and `4` as defaults and said all three were "live at their defaults
whether or not you set them"; both numbers came from the vendor's example snippets rather than from
its defaults. Corrected 2026-08-27 against `pi-subagents` `docs/configuration.md`.

| Key | Unset behaviour | Bounds |
|---|---|---|
| `maxSubagentSpawnsPerRun` | **64** (a real default, `:262`) | every child one top-level run has **ever** started |
| `maxSubagentSpawnsPerSession` | **unlimited** (`:252`) | the same, counted across the session |
| `maxActiveAsyncRunsPerSession` | **unlimited** (`:272`) | top-level async runs in flight **right now** |

This edition sets `maxSubagentSpawnsPerRun` and `maxActiveAsyncRunsPerSession` to `20` in
`config/subagent.default.json`. The second of those replaces unlimited, so it is a real tightening;
the first *lowers* the vendor default, so read the paragraph below before assuming it is free.

`maxSubagentSpawnsPerSession` is left unset on purpose. The rule this edition applied to all three
was *cap it if it bounds simultaneity, leave it alone if it is a total*, and this one is a total: it
counts every child a session has ever launched, the failed ones included, and never gives a count
back. Setting it would put a ceiling on how much work one session may do rather than on how much it
does at once, and a long day of small fan-outs would hit it for no reason anybody would recognise at
the time. The key that actually counts something simultaneous is `maxActiveAsyncRunsPerSession`,
which is set.

The first two are cumulative and their claims are never released or refunded, so a long-lived
workflow can exhaust its run budget at width 2 as surely as at width 20 — it is a spend ceiling, not
a concurrency one. A batch that does not fit is rejected **whole**, with none of its children
started:

```text
Run fan-out limit reached at <path> (64/64 used; 4 requested, 0 remaining). No children from this
admission group were started. Start a new top-level run or raise config.maxSubagentSpawnsPerRun.
```

`maxActiveAsyncRunsPerSession` is the only one of the three that counts anything simultaneous, and it
counts top-level async runs — not the children inside one of them.

### `parallel.maxTasks` and `parallel.concurrency` — dormant

These were the caps for the package's legacy top-level `tasks: [...]` dispatch path. As of 0.57.0
their resolvers (`src/shared/types.ts:2411` and `:2415`) are exported and imported but **called
nowhere in the package**, so neither key bounds anything today. This repository keeps them set for
the same reason it set them originally: they cost nothing, and a key that reappears in a later
release should find the conservative value already there rather than the package default.

### What this repository ships

`config/subagent.json`, generated at install time from `config/subagent.default.json` and git-ignored
like the rest of the personal config (see
[Generated vs tracked](../configuration/index.md#fact-2-generated-vs-tracked)):

```json
{
  "toolDescriptionMode": "custom",
  "globalConcurrencyLimit": 4,
  "parallel": {
    "maxTasks": 8,
    "concurrency": 4
  },
  "maxSubagentSpawnsPerRun": 20,
  "maxActiveAsyncRunsPerSession": 20
}
```

`4` mirrors the `concurrency` this repository's own `routing.default.json` ships for its one bundled
provider — a conservative, obviously-safe number for a machine nobody has tuned yet, not a
measurement of any particular provider's real budget. **Raise it if your provider allows more**, and
keep it no higher than the tightest `concurrency` entry in
[`routing.json`](../configuration/routing.md#concurrency) that a batch could actually hit. Do not
treat it as protection against a wide `runs.all`; for that, keep the width in the script itself
inside the provider's budget, which is what the working rules in `AGENTS.md` ask a model to do.

The file is installed at `~/.pi/agent/extensions/subagent/config.json` — the one path `pi-subagents`
reads its own config from, and the one nested symlink the installer makes; see
[Configuration layout](../getting-started/config-layout.md).

### The description the model reads

`toolDescriptionMode` ships as `"custom"`, and `config/subagent-tool-description.md` is what it
reads. That file is **tracked and edited in place** — it is not one of the generated ones — and it
is linked to `~/.pi/agent/subagent-tool-description.md`, at the agent-dir root rather than in the
nested `extensions/subagent/` directory the config file goes to. The two are resolved by different
functions in the package; the paths are not interchangeable.

The reason to own this file rather than take the package's default is that the default describes
the package's own example install. Its worked example routes to `agent:'reviewer'` — not a role in
`agents/` — and its guidelines open by requiring an `{ action: "list" }` round trip before every
execution, which is a call per delegation on a configuration whose roster is already on disk. That
correction has to live *here*: a note about a tool's behaviour placed anywhere else is read later,
weaker, and by a model that has already decided how to call it.

What the shipped file says: the thirteen roles in `agents/`, when delegating is worth its cost, the
`workflowScript` call protocol (one top-level call per turn, fan-out inside it with `runs.all`, the
ordered-array result shape, the statement-body rules), the fully-qualified per-child `model` rule,
the width and run-tree budgets above, and one writer per working directory.

Three behaviours of the mode are worth knowing before you edit it:

- **The safety guidance is re-appended whatever your file says.** `SUBAGENT_SAFETY_GUIDANCE` is
  spliced back on after your text, so prose cannot remove the runtime guardrails — and pasting a
  copy of them in is dead weight that will drift from the package's own wording on upgrade.
- **Setting the key to *any* value drops the tool's `promptGuidelines` and `promptSnippet`.** The
  package contributes them only while the key is unset. That costs nothing here, because a custom
  `SYSTEM.md` already suppresses the whole `Guidelines:` section — and it is exactly why the call
  protocol belongs in the tool description and nowhere else. See
  [Configuration layout](../getting-started/config-layout.md#the-prompt-layer).
- **A missing or invalid file does not fall back to the short default.** Missing, empty, unreadable
  or over 50 KB, and the package installs its ~6 KB *full* description instead — reviewer example
  and list mandate included — behind a single `console.warn`. That is why the installer row is
  `required`, and why a fork should keep the file in place rather than delete it.

Nothing checks the file against `agents/`. Add or remove a role and this is the second place to
edit; the failure otherwise is a model routing to a name that no longer resolves. Restart `pi`
after any change — the description is built once, when the tool is registered.

### `fleetKeybindings` — one block, two views

The same file takes an optional `fleetKeybindings` block, which is `pi-subagents`' escape hatch for
a terminal that swallows a named key — `PgUp` and `PgDn` are the usual casualties:

```json
{ "fleetKeybindings": { "pageUp": ["ctrl+b"], "pageDown": ["ctrl+f"] } }
```

It retunes **both** navigable views: the package's own `/subagents-fleet` and this repository's
[`/jobs`](../extensions/jobs.md#looking-through-them-yourself-jobs) browser, which spells its ten
shared movements exactly as the package spells them so that one override reaches both. Only those
ten are overridable from here; `/jobs`' three own actions are bound to bare letters no terminal
intercepts, so they need no hatch. A malformed entry is ignored rather than applied — an override
that silently unbound `close` would trap you inside an overlay.

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
