# `dispatch` — tiers, depth, concurrency, isolation

**There is no dispatcher in this module.** The adopted sub-agents package is the dispatcher: agent
discovery, the Markdown+frontmatter format, per-agent models and tool sets, structured delegation,
per-agent permissions, worktrees, the async fleet.

What ships here is the remainder. Configured by
[`config/dispatch.json`](../configuration/dispatch.md) and
[`config/routing.json`](../configuration/routing.md).

Registers `/agents`.

## The five parts

| Part | What it does |
|---|---|
| `depth.ts` | A depth limit that fails **loudly at dispatch**, on our number |
| `semaphore.ts` + `concurrency.ts` | Per-provider concurrency from `routing.json`, **queueing rather than erroring** |
| `isolation.ts` | Honours `isolation: worktree`; the worktree itself comes from [`worktree`](worktree.md) |
| `tiers.ts` | Tier name → `provider/id`, from `routing.json`, the single source of truth |
| `catalogue.ts` | The model registry as a dispatch surface |

## The two non-negotiable acceptance criteria

1. **A typo in an agent file is a `session_start` error**, not a surprise forty minutes into a long
   run. When a tier once named a model id that did not exist in the provider's catalogue, eight
   agent definitions refused to dispatch at session start, each naming itself and the tier. That is
   the design working.
2. **A confidential session cannot dispatch onto a public provider** — and naming a concrete model
   id rather than a tier is not a way around it.

## The catalogue is a dispatch surface, not decoration

A model cannot choose an id it does not know exists. So:

- a call-time `provider/id` is checked for existence, and a bad one is refused **with the closest
  real ids**;
- the selectable set is injected into the system prompt at `before_agent_start` as a **Sub-agent
  model selection** block, so the orchestrating model can spend deliberately — a mechanical sweep on
  a small model, a hard decision on a large one — instead of guessing an id.

The list is **filtered, not annotated**: a model that is listed but unusable is a trap that costs a
turn. What was filtered out is counted and explained on one line.

The block is built once at `session_start` and is byte-identical for the rest of the session, so it
does not churn the prompt-cache prefix. `/agents` prints the same text **verbatim** — if the human
and the model are reading different lists, the one nobody can see is the one that is wrong.

## Load order

[`guard`](guard.md) **must** load before this module. PI iterates `tool_call` handlers in load order
and returns on the first block; a blocked dispatch must never have had its arguments rewritten
first.

This module in turn must load before [`teammates`](teammates.md), [`worktree`](worktree.md) and
[`jobs`](jobs.md), which register providers and vetoes into registries it owns.

## Why a `tool_call` handler and not a tool

The dispatch tool belongs to the package. Everything this module does to a dispatch — resolve a
tier, lower a fan-out width, point a child at a worktree, refuse a call — is a mutation of or a veto
on a call the package's tool receives. Registering a competing tool would give the model two ways to
do the same thing, one of them unguarded.

## Where the semaphore cannot reach

Documented honestly in `extensions/dispatch/concurrency.ts`: there is no extension-visible hook
inside PI's own `Promise.all` phase, so parallelism PI initiates internally is outside its scope.

## Related
[`dispatch.json`](../configuration/dispatch.md) · [`routing.json`](../configuration/routing.md) ·
[Adding a sub-agent](../extending/subagents.md) · [teammates](teammates.md)
