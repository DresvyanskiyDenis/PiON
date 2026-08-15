# `auto-title` — naming the session

One cheap sub-invocation fired after turn 2, over the first exchange, to set the session display
name.

## Bounded and disposable

- Fired **after turn 2**, not turn 1 — one exchange is rarely enough to name anything.
- Bounded by a 20-second timeout using Node's own timer, because there is no guarantee a `timeout`
  binary exists on the machine.
- **Any** failure — timeout, non-zero exit, dead endpoint — is swallowed and the session carries on
  untitled.

It registers no `tool_call` handler, so the fail-closed/fail-open contract does not apply; the
`try`/`catch` plays the equivalent "our bug must never block the session" role for a `turn_end`
listener.

## Why it does not read `routing.json`

Titling is a throwaway one-liner that wants the cheapest model that exists. Reading the tier map here
would mean adding a config loader to this module and putting a **file read on the `turn_end` path** —
for a cosmetic feature.

So the default is a standalone constant — the cheapest Copilot model, not whatever `light`
currently points at — and `PI_TITLE_MODEL` is how a different install corrects it. It is deliberately
not kept in step with any tier: a tier is a promise about a *role*, and titling is not one of them.

!!! note "A wrong id here costs an untitled session and nothing else"
    Every failure of the sub-invocation is swallowed by design. This is the one place in the tree
    where a stale hard-coded model id is an acceptable trade, and the reason is written down so the
    next person does not have to guess whether it was an oversight.

## Related
[`routing.json`](../configuration/routing.md) · [session-index](session-index.md)
