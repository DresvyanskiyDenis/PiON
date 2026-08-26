# ADR 0005: A wide `runs.all` fan-out is not width-capped, and that is accepted

- **Status:** accepted
- **Date:** 2026-08-26

## Context

`pi-subagents` exposes two ways to run children in parallel, and this repository documented both as
if one setting bounded them. It does not.

`globalConcurrencyLimit` is read into a semaphore that is constructed **per execution**, at three
separate sites in the pinned 0.41.0 — a background run
(`src/runs/background/subagent-runner.ts:1941`), a foreground run
(`src/runs/foreground/subagent-executor.ts:3381`, which is the path a plain dispatch takes), and a
chain step's `parallel: [...]` group (`src/runs/foreground/chain-execution.ts:749`). It is consumed
in exactly one place: the worker loop of `mapConcurrent`, which acquires at
`src/runs/shared/parallel-utils.ts:191` and releases at `:195` while walking the items of **one**
batch. Unset, it falls back to the package's own `DEFAULT_GLOBAL_CONCURRENCY_LIMIT = 20`
(`parallel-utils.ts:128`).

`runs.all([...])` never enters that loop. It validates its items and then `Promise.all`s N
independent host calls (`src/workflows/scripted-workflow.ts:70`); each reaches its own
`execute(randomUUID(), …)` as a single-child execution and constructs its own semaphore, which it
never contends with. N launches, N semaphores, nothing bounding N. Measured on 2026-08-26: eight
children dispatched, eight ran concurrently, peak eight, no queueing — the 3.58 s spread in start
times was each child's own first-turn latency, not a wait for a slot.

The path is not ungoverned. A workflow's `usageBudget` is enforced once across the workflow. But that
is a **cost** ceiling, not a width one: it can stop a fan-out after the fact, and cannot stop twelve
provider calls opening at the same instant.

Three places in the documentation asserted the opposite. The claim was wrong in its *mechanism*, not
merely in its number, which is why it survived review for weeks: a plausible-looking citation pointed
at a real semaphore that really does bound something, just not the thing being described.

## Decision

**The `runs.all` path stays width-uncapped. Enforcement was considered and deliberately not
implemented; the documentation states the gap instead.**

Concretely: `globalConcurrencyLimit` is documented as bounding children within one parallel batch and
within a chain step's `parallel:` group. Keeping a fan-out inside the provider's `concurrency` budget
is stated as the caller's job, in `AGENTS.md`, on the [sub-agents](../extending/subagents.md)
page, and in `config/subagent.json`'s own comment — the three places a reader could otherwise pick up
the old claim.

## Consequences

**Positive**

- The remaining documentation is true about the mechanism, so a reader who sizes a fan-out against
  the provider budget gets the answer the code will actually produce.
- No wrapper sits between a workflow script and the runtime, so an upstream change to how `runs.all`
  launches children cannot silently invalidate a local cap.
- The setting keeps doing the real work it does, on batches, rather than being removed for not doing
  work it never did.

**Negative**

- A script that fans out twelve ways opens twelve concurrent provider calls, and a provider on a
  tighter budget answers with 429s. Nothing in this repository catches that before it happens.
- The protection is a documented instruction to a model, which is weaker than a check.
- Anyone reading only `config/subagent.json`'s key names could still infer the old, wrong reading;
  the `_comment` exists for exactly that reader.

**Neutral**

- The `usageBudget` ceiling is unaffected and still applies to the same path.

## Alternatives considered

| Option | Why not |
|---|---|
| Wrap `runs.all` and admit items through a repository-owned semaphore | It is the only real fix, and it means owning a scheduler that shadows the package's own. It would have to be re-verified against every `pi-subagents` upgrade, and getting it wrong deadlocks a fan-out rather than merely widening it. Too much machinery to defend a limit that a one-line instruction defends nearly as well. |
| Refuse a `runs.all` whose item count exceeds the configured limit | Cheap, and it turns a working wide fan-out into a hard failure. The width is usually legitimate; the provider budget is the real constraint, and it varies per provider and per key. A refusal keyed to a number nobody measured trains people to raise the number. |
| Ask upstream to make the semaphore process-wide | The right long-term home for it, and not something to block on. Worth raising; not a reason to leave the documentation wrong in the meantime. |

## Reopen this if

- `pi-subagents` gains a process-wide or workflow-wide concurrency limit — then adopt it and
  supersede this ADR rather than reinterpreting it.
- A wide fan-out is observed producing provider 429s in normal use, rather than in a deliberate
  stress test. That converts the negative consequence above from theoretical to measured, which is a
  different decision.
- The `usageBudget` check moves, changes scope, or stops being enforced once per workflow — the
  "governed, but on cost" half of this argument depends on it.

## Related

- [Sub-agents](../extending/subagents.md) — what each concurrency setting bounds
- [Routing](../configuration/routing.md#concurrency) — the per-provider budget this defers to
- [Package ledger](../PACKAGES.md) — `pi-subagents` 0.41.0, the version every line reference above
  was verified against
