# ADR 0007: A zero-token empty-response gets one hop to a working path; every other failure still just aborts

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

[ADR 0001](0001-no-provider-failover.md) already settled the general case: a provider error aborts
the turn, with no failover and no substitution. That decision is sound for the failures it was
written against — auth, quota, a model that silently returns something else, a policy block — because
in every one of those cases the provider gave back a *reason*, and retrying that reason against a
different backend is a decision an operator should make, not one the harness should make for them.

An empty-response is different in one specific shape: when the completion carries no text, no tool
calls, nothing usable, *and* the request's own token accounting shows zero prompt tokens and zero
completion tokens consumed, nothing about the failure is provider-specific. Nothing was read, nothing
was generated, and there is no partial work or partial spend this hop could put at risk by trying
another deployment before giving up. That is a narrower and more mechanical claim than "the provider
had a bad turn" — it is closer to "the request never actually landed." A non-zero-token empty response
(some tokens billed, nothing usable came back) keeps every existing behavior: it is still governed by
`onProviderError.retry`'s existing vary-and-retry policy, and it still aborts with no failover once
that budget is spent, exactly as ADR 0001 describes.

Treating the zero-token case identically to every other empty-response, or identically to auth/quota/
policy, forces a choice between two costs: either the retry budget silently absorbs a request that
never actually reached a model, or the operator eats a full turn abort for a failure that was, by its
own token accounting, a no-op. Both costs are avoidable without touching ADR 0001's actual claim,
because the zero-token signal is detectable at the harness's own error-classification boundary before
any retry decision is made.

## Decision

**A provider failure classified as `empty-response` with `usage.input === 0` and `usage.output ===
0` gets exactly one hop to a configured fallback tier, instead of the normal same-provider/model
retry — and that one hop is spent for the rest of the streak.** Every other error class, and every
non-zero-token empty-response, is unaffected: ADR 0001's abort-with-no-failover posture holds for all
of them, unchanged.

Mechanism:

- The fallback is named by `onProviderError.workingRoute.zeroTokenFallback` in `routing.json`
  (`config/routing.default.json:51-53` in this tree) — either a tier name (resolved the same way
  `compaction.route` already resolves tiers) or a literal `provider/id`.
- The harness ships this repository's own `confidential` tier as the default. `confidential` already
  has standing as a fallback destination: `compaction.route` (`config/routing.default.json:57`) routes
  compaction to `["light", "confidential"]` for the same reason — it is the tier reserved for traffic
  that should not simply retry against whatever public endpoint just failed. This repository ships
  `confidential` **unbound** by default (`tiersUnbound`, `config/routing.default.json:17-19`) because
  no egress-`confidential` provider is installed out of the box; naming an unbound tier here is a
  deliberate, visible failure rather than a silent one — see Consequences.
- The hop takes the request to a genuinely different deployment (different provider, or same provider
  with a different model) than the one that just returned zero tokens. If the resolved fallback
  *is* the same deployment, or resolves to a model absent from this session's registry, or has no
  credential configured, the hop declines and the turn aborts exactly as it would have without this
  decision — the zero-token case degrades to ADR 0001's baseline, it never degrades further.
- One hop per streak: if the fallback also comes back as a zero-token empty-response, the second
  failure aborts. This is not a second retry budget layered on top of `onProviderError.retry` — it is
  a single, one-shot detour that either recovers the streak or gets out of the way.
- The hop is announced to the user (the same notice channel every other provider-error surface uses)
  and recorded as a `provider_error_route_hop` transcript entry, mirroring the existing
  `compaction_route_hop` entry compaction already writes when it fails over between route targets —
  so a reviewer reading a transcript can see when and why the harness changed which deployment was
  handling a request without being told by the model.

A new pi-check rule, **PC-33**, warns (never fails the build) when
`onProviderError.workingRoute.zeroTokenFallback` cannot resolve to a usable target: an empty string
disables the hop and is not warned about, but an unresolvable tier name, an unbound tier, or a
malformed `provider/id` literal is — on the same reasoning PC-02 and PC-20 already apply to `tiers`
and `path-defaults.json`'s `tier` field. It is a warning and not a finding because an unresolvable
fallback is a legal configuration: the hop simply declines and the turn aborts, which is the same safe
default this decision falls back to at runtime regardless of what pi-check says about it.

## Consequences

**Positive**

- A request that consumed nothing and produced nothing gets one more chance before the turn is lost,
  without weakening ADR 0001's guarantee for every failure that actually reached a model.
- The hop is visible: a notice at the time it happens, and a transcript entry after the fact. Nothing
  about this decision lets the harness quietly change providers without telling anyone.
- The one-hop-per-streak limit means a fallback that is itself broken cannot turn one failure into an
  unbounded chain of them; the worst case is exactly one detour, then the same abort ADR 0001 already
  specifies.

**Negative**

- This repository's shipped default (`confidential`) is **unbound out of the box** — PC-33 will
  correctly warn on a fresh checkout, and the hop will decline every time until an operator runs
  `scripts/install.sh` and binds an egress-`confidential` provider (for example, a self-hosted or
  in-boundary endpoint). This is a deliberate trade: shipping a *different* default that resolves
  cleanly out of the box would mean shipping a public tier as the "get away from a failing public
  endpoint" destination, which defeats the point of having a hop at all. An operator who wants the
  hop live from install day one has one config line to add.
- The zero-token signal is a proxy, not a certainty. It is possible in principle for a provider to
  report `usage.input === 0, usage.output === 0` on a response that is genuinely provider-specific
  rather than a no-op — this decision accepts that as a rare misclassification, bounded by the
  one-hop limit, rather than trying to distinguish it further.

**Neutral, noted but not built**

- `headlessAbortLine` (`extensions/lib/provider-error.ts`) is deliberately left unextended: a
  hop-only failure surfaces through its own `HopDisposition` formatting rather than through the
  retry-attempt line every other failure uses, and this decision does not unify the two beyond what
  `policyLine`'s existing priority check (hop over retry, when both could apply) already gives it.
- `RetryDisposition` gained no new field for this decision. The "hop already spent" and "streak-restart
  cap already reached" cases are represented as `HopDisposition.declinedReason` strings rather than as
  a new boolean on `RetryDisposition`, keeping this decision's shape additive and self-contained rather
  than widening a type every other error class already reads.

## Alternatives considered

| Option | Why not |
|---|---|
| Fold the zero-token case into the existing `empty-response` retry budget (retry same provider/model, vary thinking level, as today) | This is the status quo the decision replaces. A request that consumed zero tokens is not the same failure `onProviderError.retry`'s vary-and-retry was designed for — it never reached a model, so retrying against the same deployment answers a question ("was that a fluke?") the token accounting has already answered ("nothing happened"). |
| Treat a zero-token empty-response as just another `empty-response` and let it abort with no failover, per ADR 0001 | Correct for every failure that actually reached a model. Applying it to a request that provably consumed and produced nothing throws away a free signal: there is no partial work or partial spend this hop puts at risk by trying once more elsewhere. |
| Allow the fallback tier to also retry (i.e., give the hop its own multi-attempt budget) | Turns one detour into a second failover chain layered on top of `onProviderError.retry`'s existing budget, softening ADR 0001's "no failover" guarantee for a case this decision was supposed to keep narrow. One hop, once, keeps the blast radius equal to exactly one extra attempt. |
| Ship a bound default (e.g., point `zeroTokenFallback` at `light`, which is bound to `github-copilot` out of the box) | Would resolve cleanly with zero setup, but a "working-path hop" whose fallback is the *same* public provider egress class as everything else it is meant to route away from does not do the job the decision is named for. Consistent with `compaction.route`'s own choice of `confidential` as its second hop, not `light`. |

## Reopen this if

- A provider is observed reporting `usage.input === 0, usage.output === 0` on a response that is
  reliably NOT a no-op (a real completion the token accounting simply mis-reports) — that would mean
  the zero-token signal is not the proxy this decision assumes it is, and the classification needs a
  second signal alongside token counts.
- An operator workflow emerges where the one-hop-per-streak limit is routinely too tight (the fallback
  itself is flaky enough that one hop rarely lands) — that is evidence for a small, explicit multi-hop
  budget, not for silently widening this one.
- `confidential` stops being the right shipped default — for example, if a future install path binds a
  different tier by default before `scripts/install.sh` runs, or if `compaction.route`'s own choice of
  fallback changes for reasons this ADR should track.

## Related

- [ADR 0001](0001-no-provider-failover.md) — the general rule this decision narrows one specific,
  provably-zero-cost case out of, without touching the rule itself.
