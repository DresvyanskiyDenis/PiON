# `dispatch` — tiers, depth, concurrency, isolation

**There is no dispatcher in this module.** The adopted sub-agents package is the dispatcher: agent
discovery, the Markdown+frontmatter format, per-agent models and tool sets, structured delegation,
per-agent permissions, worktrees, the async fleet.

What ships here is the remainder. Configured by
[`config/dispatch.json`](../configuration/dispatch.md) and
[`config/routing.json`](../configuration/routing.md).

Registers `/agents`.

## The parts

| Part | What it does |
|---|---|
| `depth.ts` | A depth limit that fails **loudly at dispatch**, on our number |
| `semaphore.ts` + `concurrency.ts` | Per-provider concurrency from `routing.json`, **queueing rather than erroring** |
| `isolation.ts` | Honours `isolation: worktree`; the worktree itself comes from [`worktree`](worktree.md) |
| `tiers.ts` | Tier name → `provider/id`, from `routing.json`, the single source of truth |
| `catalogue.ts` | The model registry as a dispatch surface |
| `thinking.ts` | The reasoning-effort suffix: what was asked, what the model serves, what will actually run |
| `async-fleet.ts` | Re-reads the state a background run wrote for itself, and announces the ones that ended |

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

## Reasoning effort is disclosed, never assumed

A reasoning effort rides inside the model string as a suffix (`provider/id:max`), and that suffix is
a **request**: PI clamps it against the model's declared vocabulary before the wire. Nothing warned
about that, so a run commissioned at `max` could ship at `high` and record `max` in its own metadata
— visibly wrong only to someone who went looking.

Now every dispatch that would be clamped says so, naming the requested level, the effective one,
what the model does serve, and which other configured providers serve what was asked — each with its
egress class, because moving between classes is the operator's decision and not a routing
optimisation. It is a hint: **nothing is rerouted**. The model string is rewritten to the effective
level before the package sees it, so the run metadata and the announcement agree with the wire.

The menu prints the same thing rather than the request alone — `effort high (asked max; <provider>
does not serve it — serves low|medium|high)` — and `/agents` lists any tier in that state under
`reasoning effort CLAMPED:`. A model whose vocabulary the registry does not know produces no
disclosure and no rewrite: "cannot say" must not render as "no clamp will happen". Whether a clamp
warns or refuses is
[`onThinkingClamp`](../configuration/dispatch.md#onthinkingclamp).

## Async runs announce their own terminal state

`pi-subagents` acknowledges an async dispatch with a promise to wake you when it finishes. When that
delivery path fails, nothing enters the transcript at all — and the acknowledgement is then the only
in-context evidence the orchestrator has, so it keeps reporting a run that died seconds ago as live.
Measured: every async result file of one session still on disk, undeleted, `"state": "failed"`, and
zero notifications in the transcript.

This module does not add a second lifecycle. The authoritative state is already on disk in the run's
own `status.json`, written by the package's runner; the only thing missing was that nobody read it
unless the model thought to ask. So each async spawn's directory is remembered, re-read at
`turn_end`, and each run that has reached a terminal state and has not been reported yet produces one
message. `paused` is deliberately **not** terminal — announcing it would spend the run's single
announcement and hide the real ending.

Duplication was chosen over silence: if the package's own notification does arrive, you may hear
about a finished run twice. Being told twice is a nuisance; not being told is a wrong answer. The
upstream delivery failure is routed around, not repaired.

That trade does **not** extend to your own reads. A run you waited on, polled, or read the artifact
of is marked consumed and never announced — the announcement is for the run nobody told you about.
Measured 2026-08-26: one run was waited on, polled, read and its todo closed, and the announcement
arrived two minutes later saying "read the artifact above". That is not a doubled report, it is a
stale instruction to reconcile against work already done. Consumption requires the run's own
`status.json` to be terminal at the moment you looked: polling a run that is still running says
nothing about how it ends, so it does not spend the announcement, and neither does reading a run
that never wrote a `status.json` — "never started" still gets said.

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
`light` onto whatever provider id happens to contain it — routing by accident, onto a provider
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

## What a resolution leaves behind

`/agents` describes what **can** be dispatched. It cannot answer *what did this delegation actually
run on, and why* — so every resolution is written to the [session index](session-index.md) as one
row, under kind `dispatch` and name `dispatch.resolve:<agent>`. That is the same
`<domain>.<action>:<subject>` shape [teammates](teammates.md) writes into the same bucket, so
`/index` and `bin/pi-log events` read one stream rather than two incompatible ones.

The payload carries identifiers only: the `subagent` tool the call came in on, the agent named, the
resolved provider, and the model record — where the spec came from (`from`), what it resolved to
(`to`), the tier if it came from one, and `defaultedScope` when the value was the
[`defaultTier`](../configuration/dispatch.md#defaulttier-and-defaultegress) rather than something
asked for. The clamped concurrency and the isolation appear too, when either was applied.

Two properties are deliberate, and a consumer of `/index` has to know both:

- **The row is written on resolution, not on rewrite.** "The call already named exactly the model we
  resolved to" is still a resolution worth recording; keying the row off the rewrite would silently
  under-report a real share of delegations.
- **A refused call writes no `dispatch.resolve` row.** The block is already carried by the guarded
  handler's own audit entry, and a call that resolved no model has nothing to say about what it ran
  on. Reading only this kind therefore counts delegations that proceeded — the refusals are in the
  other place.

Logging cannot fail a dispatch. The write swallows its own failures by contract, and the session-id
lookup that precedes it is wrapped, so an unwritable index degrades the event log and leaves the
verdict and the arguments exactly as they were.

## Where the semaphore cannot reach

Documented honestly in `extensions/dispatch/concurrency.ts`: there is no extension-visible hook
inside PI's own `Promise.all` phase, so parallelism PI initiates internally is outside its scope.

## Related
[`dispatch.json`](../configuration/dispatch.md) · [`routing.json`](../configuration/routing.md) ·
[Adding a sub-agent](../extending/subagents.md) · [teammates](teammates.md)
