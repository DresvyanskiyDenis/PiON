# ADR 0001: A provider error aborts the turn

- **Status:** accepted
- **Date:** 2026-08-13 (recorded at publication; the decision is older)

## Context

An agent harness that reaches several model providers has an obvious-looking feature available to
it: when one provider fails, try the next. Every commercial agent product ships some version of it,
and the argument for it is easy to make — the user asked a question, the user should get an answer.

The counter-argument only appears once you have operated one. A harness that substitutes providers
silently produces results whose origin you cannot reconstruct. You read an answer and you do not know
which model wrote it, which context window it had, whether it was the tier the sub-agent asked for,
or how much it cost. When it is *wrong*, you cannot tell whether the prompt was bad or the fallback
model was weaker. When it is right, you cannot reproduce it.

The problem compounds in this harness specifically, because routing is by **semantic tier** and one
tier — `confidential` — is defined by *where the endpoint is*, not by how good it is. A failover path
that treats providers as interchangeable will, on a bad day, answer a `confidential` request from a
public endpoint. Whatever that is, it is not a fallback; it is a disclosure.

There was also a concrete near-miss: a failover extension was specified for this tree and then
cancelled before implementation, because no reviewer could describe its behaviour in the
`confidential` case without adding a special case that amounted to "do not fail over" for the tier
that mattered most.

## Decision

**A provider error aborts the turn.** `config/routing.json` carries:

```json
"onProviderError": {
  "policy": "abort",
  "substituteProvider": false,
  "report": ["provider", "model", "errorClass", "message", "causeChain"]
}
```

The abort names the provider, the model, the error class, the message and the cause chain. Five
error classes are distinguished: `auth`, `quota`, `network`, `model-not-found`, `policy`.

!!! note "Amended 2026-08-14 — a sixth class, `empty-response`"
    A well-formed HTTP 200 that carries no completion is a provider failure that no error text
    describes, so it was not caught by a vocabulary built out of error messages. It is now a class
    of its own, recognised by shape rather than by wording. The decision above is unchanged: it is
    still an abort, still no substitution.
    [Reference](../configuration/routing.md#onprovidererror).

The decision is enforced mechanically, not by convention: `bin/pi-check`'s `PC-03` fails the
repository if a `fallback`, `failover` or `egressOrder` key appears anywhere in the configuration
tree, and `PC-05` fails it if a sub-agent definition carries `fallbackModels`.

One thing that *is* retried is a transient transport failure against the **same** provider — PI's own
`retry` setting, three attempts by default. `retry.provider.maxRetries` is set to `0`, because a
provider-level error (auth, quota, policy) is almost never transient and retrying it three times
turns a two-second diagnosis into a two-minute one.

!!! note "Amended — one harness-level retry for `network` and `empty-response`"
    `retry.provider.maxRetries` stays `0` for the reason above, and it is right for four of the six
    classes. It is wrong for two: a `network` failure never reached the model, and an
    `empty-response` is a `200` that carried no completion. Neither is a verdict about the request,
    and one of them was observed killing a **dispatched sub-agent mid-mission** — destroying paid
    work rather than a turn an operator can retype.

    So `onProviderError.retry` gives exactly those two classes exactly one more attempt, **to the
    same provider and the same model**. The decision above is unchanged: no substitution, no
    fallback chain, and the abort is still where all six classes end up.
    [Reference](../configuration/routing.md#retry-the-two-classes-that-are-weather-not-a-verdict).

!!! note "Amended — compaction has a route, and the working path still does not"
    This decision was written about the path that produces the **work**, and it is unchanged there.
    It was also being applied, by inheritance, to a path it was never argued for: **compaction**.

    The compaction call borrowed the session's own model, so the one call that has to succeed while
    the lead's provider is refusing was aimed at the thing that was refusing. A quota wall on the
    lead's deployment took out the turn *and* the ability to shrink out of the corner. The session
    could neither work nor compact, which is not "failing loud and fast" — it is a deadlock, and the
    exit was a human changing model by hand.

    So `routing.json` gained a `compaction` block with an ordered `route`. Every argument above
    survives it, because none of them is about this path. Attribution: the product is a summary of a
    conversation, not an answer whose author you need to reconstruct. Disclosure: the route is a
    *declared list of endpoints*, so a `confidential` candidate is one an operator wrote down, and
    nothing picks a destination by looking at what is currently broken. Silence: the route is printed
    at session start, every hop is announced and persisted, and an exhausted route writes a session
    fact so the news survives the cut it is about. A content-filter refusal does not hop at all —
    that is a verdict about the data, and re-offering it elsewhere is egress-shopping.

    `onProviderError` is untouched: `policy: abort`, `substituteProvider: false`, and `PC-03` still
    fails the repository on a `fallback`, `failover` or `egressOrder` key anywhere in the file.
    [Reference](../configuration/routing.md#compaction).

## Consequences

**Positive**

- Every result is attributable. The provider that produced an answer is the provider you asked for.
- Failures are loud and fast, and the message contains enough to act on without reproducing.
- The `confidential` tier means something. There is no path by which a request bound to an in-boundary
  endpoint ends up at a public one.
- The rule is checkable, so it survives contributors who did not read this document.

**Negative**

- A provider outage stops work. There is no automatic degradation to a second provider — for the
  work. Compaction is the one exception, argued above and confined to itself.
- Unattended runs fail rather than limp. A scheduled job hitting a quota wall exits non-zero at
  02:00 instead of producing a cheaper answer nobody asked for. (Some operators genuinely want the
  cheaper answer. They should use a different harness, or wrap `bin/pi-run` in their own retry.)
- Switching providers during an outage is a manual edit plus a restart.

**Neutral**

- Nothing prevents *you* from implementing failover outside the harness — a wrapper script that
  re-invokes `bin/pi-run` with a different tier on exit code `20` is ten lines. The difference is that
  it is your explicit decision, visible in your script.

## Alternatives considered

- **Failover with an audit log.** Substitute, but record what happened. Rejected: the record is read
  after the fact, if ever, and the confidential case still has to be special-cased. A control that
  depends on someone reading a log later is not a control.
- **Failover only within an egress class.** Substitute a public provider for another public one, never
  across classes. Rejected as the most tempting option: it fixes the disclosure problem and leaves the
  attribution problem entirely intact, which is the one that costs debugging hours every week.
- **Failover only for `network` errors.** Narrower, and defensible. Rejected because the
  classification is unreliable — gateways return network-shaped errors for quota and policy refusals —
  so the narrow rule would widen itself in practice.
- **Per-tier opt-in.** A `failover: true` key on the `light` tier only. Rejected on cost: it doubles
  the number of states every downstream module has to reason about, to serve the tier where a failure
  matters least.

## Related

- [Providers and tiers](../concepts/providers-and-tiers.md#fail-loud-no-failover)
- [`config/routing.json`](../configuration/routing.md)
- [ADR 0004](0004-egress-classes-are-declarative.md) — what the egress classes do and do not promise
