# ADR 0002: The guard fails open, hooks fail closed

- **Status:** accepted
- **Date:** 2026-08-13 (recorded at publication; the decision is older)

## Context

Two things in this tree can refuse a tool call, and both can themselves malfunction.

The **guard** is the permission layer: six ordered gates over every tool call, written in TypeScript,
part of this repository. **Hooks** are declarative rules in `config/hooks.yaml` that a user writes —
match a tool call by pattern, deny it or run a script that decides.

"What should happen when the checker itself throws?" has two defensible answers, and the literature
gives them opposite names for good reasons. Fail closed and a bug in the checker stops all work. Fail
open and a bug in the checker silently removes the protection.

Choosing one answer for both would be wrong in one of the two cases, and the cost is asymmetric in
opposite directions. So the question had to be sharpened before it could be answered.

The sharper question is: **whose bug is it, and who can tell it happened?**

A guard crash is *our* bug — a defect in code the user did not write and cannot easily inspect. If it
fails closed, a bad release of this repository makes every machine that pulled it unable to run
`bash`, `read` or `write`, for a reason the user cannot diagnose because the component that would
have explained it is the one that crashed. That is a denial-of-service shipped as a security feature.

A hook failure is *the user's* rule. They wrote a rule saying "never let the agent touch this path".
If that rule silently stops applying because the script it calls is missing or timed out, the user
believes they are protected and is not. The silence is the whole problem: a rule that fails open is
strictly worse than no rule, because it manufactures false confidence.

## Decision

Split them, on that question.

```json
// config/guard.json
"onInternalError": "open"
```

- **The guard fails open** on an internal error. A gate that throws is reported loudly — once, with
  the error — and the call proceeds. `bin/pi-check` and `/doctor` surface the failure so it is visible
  rather than tacit.
- **Hooks fail closed.** A `run` rule whose script is missing, throws, or exceeds its timeout **denies
  the call**. A rule that cannot evaluate is treated as a rule that matched.

The asymmetry is deliberate and is stated in the module headers so nobody harmonises it later.

Underneath both sits a third mechanism that is neither: the **deadman** in `extensions/trust.ts`. If a
guardrail *module* fails to load at all, the deadman blocks `bash`, `write`, `edit`, `multiedit`,
`read` and `grep` outright. Failing open is a response to a gate misbehaving; it is not a response to
the gate being absent. A missing guard is not a degraded guard, it is no guard, and the tools that
matter stop until it is back.

## Consequences

**Positive**

- A defect in this repository degrades to "unprotected and noisy", never to "your machine is bricked".
- A user-written rule either applies or refuses. It never silently lapses.
- The distinction is teachable in one sentence — *whose bug is it?* — which is why it has survived
  review unchanged.
- The deadman covers the case where the fail-open reasoning does not apply, so the open default is not
  load-bearing for the catastrophic case.

**Negative**

- There is a real window in which a crashed gate permits calls it should have refused. It is loud, but
  it is real. Anyone whose threat model cannot tolerate that window should treat a guard error report
  as a stop-work signal, not a warning.
- A broken hook script blocks work until it is fixed, and the failure mode looks like "the agent
  refuses everything". The troubleshooting page leads with it for that reason.
- Two different behaviours in one system is a thing to explain to every new reader. This ADR is the
  cost of that.

**Neutral**

- `onInternalError` is a configuration key, so an operator with a different threat model can set the
  guard to fail closed. The default encodes a judgement, not a constraint.

## Alternatives considered

- **Both fail closed.** The instinct-driven answer. Rejected: it turns a bug in this repository into a
  fleet-wide outage, and the mechanism that would tell you why is the one that broke.
- **Both fail open.** Rejected outright for hooks: a user-authored deny rule that silently stops
  applying is the exact failure a permission system exists to prevent.
- **Fail closed only for gates classified as security-critical.** Rejected on classification cost —
  the boundary would need maintaining forever, and a misfiled gate fails in the direction nobody
  expected.
- **Retry the gate, then decide.** Rejected: a throwing gate is deterministic in practice, so a retry
  buys latency and no information.

## Related

- [Safety model](../concepts/safety-model.md#2-fail-closed-fail-open--and-which-is-which)
- [`guard`](../extensions/guard.md) · [`hooks`](../extensions/hooks.md) · [`trust`](../extensions/trust.md)
- [`config/guard.json`](../configuration/guard.md)
