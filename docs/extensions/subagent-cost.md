# `subagent-cost` — what the children spent

Publishes a second money figure in the statusline, beside the `cost` segment. No command, no
configuration beyond one icon entry.

## The number the footer was missing

`@narumitw/pi-statusline`'s `cost` segment sums the `usage` on assistant, toolResult, compaction
and branch_summary entries. A subagent's spend is in **none** of them: a `subagent` tool result
carries no `message.usage` at all — measured across 1263 of them, the field was populated on
exactly zero. The child's money lives one level down, in the tool result's `details`, which the
statusline package neither knows about nor should.

So on a fan-out session the footer figure is short by most of the bill. Short, not over — the
direction nobody double-checks.

## A pair, not one total

```
💸 $0.267   👥 +$1.94
```

The left number is unchanged: what the main agent spent. The right one is what its children spent.
Folding the two together would have been tidier and would have silently redefined a number people
have been reading for a long time.

## Three states, kept apart

A wrong number here is worse than an absent one, so zero, unknown and estimated never render the
same way.

| Display | Meaning |
|---|---|
| `+$1.94` | Children finished and reported this |
| `+$0.000` | Children finished and genuinely spent nothing |
| `+$?` | Children reported **tokens** and a cost of exactly zero |
| `+$1.94 ?2` | The same, for two runs, alongside a total that is otherwise known |
| `+$1.94 ~3` | Three launched runs whose cost has not landed |
| `+$1.94 ✗1` | One counted child failed, timed out or was stopped — it still spent its money |
| `+$1.94 (sub 2)` | Two counted children billed against a seat, so those dollars are an estimate |
| *(nothing)* | This session has spawned nothing |

!!! warning "`$0.00` is the signature of an expired price table"
    A model with no declared rates, or a gateway that starts metering after its rates were
    recorded, prices every call at exactly zero — and keeps doing so, silently, for as long as
    nobody re-probes. A cost of zero against non-zero tokens is therefore reported as **unknown**,
    not as free. See [`config/models.json`](../configuration/models.md) on why rates are probed
    rather than copied from a price page.

## `~N` is not always transient

A `subagent` call that launches a **detached** run returns with no cost key at all, and unless a
later `subagent_wait` collects that run, its money never reaches the session file. Those runs stay
pending for the life of the session, which is the honest display: the harness does not know what
they cost and will not guess.

## How it reads the session

`ctx.sessionManager.getEntries()` — the same call, over the same set, the statusline package uses
for the parent number. The two halves of the pair cannot drift, and both survive a resume or a
fork, where an in-process counter would restart at zero beside a parent total that did not.

A run is counted once. A `subagent_wait` that re-reports a run its own launch already accounted
for is a *view*, not a second bill.

## Posture

Every handler is a lifecycle hook and every one is guarded: a bug in an optional cost display must
never take down a turn, let alone the session. Unlike [`quota`](quota.md) there is no
user-initiated command here, so there is no fail-loud half to balance it.

The statusline package is **adopted, not forked**. This reaches the footer through
`ctx.ui.setStatus` and a `config/pi-statusline.json` `extensionStatusIcons` entry — the supported
seam. A patch under `node_modules` would survive exactly until the next install.
