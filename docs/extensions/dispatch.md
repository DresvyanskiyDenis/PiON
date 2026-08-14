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
2. **Naming a concrete `provider/id` is not a way around the existence check.** A tier is resolved
   and verified at `session_start`; a raw id typed at the call is verified at the call, against the
   same registry, and refused with the closest real ids. Neither path can reach a model nothing
   serves.

!!! note "There used to be a third one, and it was withdrawn on 2026-08-13"

    Until then this list also read *"a confidential session cannot dispatch onto a public
    provider"*, and the module enforced it: the resolved provider's egress class had to be no
    looser than the session's, at load time and at call time.

    It was removed because it refused far more than it protected. Most providers are classed looser
    than a confidential session, so most agents became undispatchable and switching provider
    mid-session was impossible — while nothing about the actual network changed either way, since
    the class is a word in a config file and no socket is inspected. The classes stayed; the refusal
    went. They are printed wherever a model or an agent is listed, and refuse nothing.
    [ADR 0004](../adr/0004-egress-classes-are-declarative.md).

## The catalogue is a dispatch surface, not decoration

A model cannot choose an id it does not know exists. So:

- a call-time `provider/id` is checked for existence, and a bad one is refused **with the closest
  real ids**;
- the selectable set is injected into the system prompt at `before_agent_start` as a **Sub-agent
  model selection** block, so the orchestrating model can spend deliberately — a mechanical sweep on
  a small model, a hard decision on a large one — instead of guessing an id.

The list is **annotated, not filtered**: every id the registry knows is shown, each with its
provider's egress class — or `unlabelled`, when `routing.json` gives that provider no class. Since
nothing refuses a dispatch on account of a class, hiding models by class would only shorten the menu
while leaving them selectable by hand. Each tier line carries the same annotation plus the reasoning
effort it resolves to, so the cost of a choice is visible at the point of choosing.

Until 2026-08-13 the list was filtered by the session's own class and what had been removed was
counted on one line. The filter went with the containment rule it implemented.

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

## The workflow floor, and the package internal it rests on

A `workflowScript` call launches children *inside* the package, past the point where this module
turns a tier word into a `provider/model`. A child that names no model therefore arrives at PI's own
substring matcher carrying its agent file's tier word, and that matcher will resolve a word like
`fast` onto whatever provider id happens to contain it — routing by accident, onto a provider
`models.json` never declared, surfacing as a credentials error rather than as the substitution it
is.

So when a `workflowScript` names no `model`, the resolved
[`defaultTier`](../configuration/dispatch.md#defaulttier-and-defaultegress) is written onto the call
as a **floor**: `pi-subagents` keeps a top-level `model` in its workflow child defaults and spreads
it *underneath* each child's own parameters, so children that name no model inherit it and children
that name one are untouched. The pin is announced when it happens, in wording that says it is a
floor and what overrides it.

This is the one rule in the module that depends on a package **internal** rather than on a
documented argument (`pi-subagents` 0.41.0, `src/runs/foreground/subagent-executor.ts`, the
`workflowChildDefaults` destructure and the child-params spread). `test/dispatch/rules.test.ts`
asserts that source's shape directly, so an upgrade that drops `model` from the defaults, or flips
the spread order, fails the suite instead of quietly changing what a fan-out runs on. Re-check it
whenever the package is upgraded.

## Where the semaphore cannot reach

Documented honestly in `extensions/dispatch/concurrency.ts`: there is no extension-visible hook
inside PI's own `Promise.all` phase, so parallelism PI initiates internally is outside its scope.

## Related
[`dispatch.json`](../configuration/dispatch.md) · [`routing.json`](../configuration/routing.md) ·
[Adding a sub-agent](../extending/subagents.md) · [teammates](teammates.md)
