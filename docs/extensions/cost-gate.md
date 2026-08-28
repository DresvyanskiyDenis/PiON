# `cost-gate` — the session ends before it lies about money

A model billed tokens. `models.json` never said what they cost. This module ends the run rather
than let the status line report `$0.000` for the rest of the session.

## The defect it exists for

`cost` is **required** on PI's runtime model type and **optional** in `models.json`. The provider
composer closes the gap silently, substituting
`{ "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }` for any model definition that omits
it. Nothing warns, nothing fails, and every downstream consumer of the rate — the status line
included — sees an ordinary cost object full of zeros.

After that substitution **an authored zero and a forgotten field are the same object**. There is no
runtime question you can ask that separates "this endpoint is free" from "nobody wrote a price
down".

The way that turns into a real bill is not a typo. A gateway that serves a model group for free can
start charging for it later. The zeros somebody wrote against it were true when they were written
and are false afterwards; no line of configuration changes, nothing fails, and there is no surface
on which the change can appear. The sessions keep reporting nothing while a real bill accumulates.

## What it does

Fires on `message_end`, and only when every one of these holds:

1. the message is an **assistant** message,
2. its **token counters** show billed tokens,
3. the model's `cost` in `models.json` is **absent or incomplete**.

Then it prints the failure block, notifies, sets a non-zero exit code in headless mode, and calls
`ctx.abort()`.

!!! note "Token counters, never `usage.cost`"
    `usage.cost` is zero by construction in exactly the case this gate is looking for. Testing it
    would disarm the gate on every session it exists to catch.

!!! tip "Why the first billed turn is a cheap place to stop"
    On a fresh session that is turn one. The run ends before any work exists, the fix is one line in
    `models.json`, and the operator starts again. Weigh that against a session that runs to
    completion misreporting its spend, and it is not a close call.

    It is still the *earliest moment the evidence exists*, which is not the same as early: on a
    fresh install, turn one was billed before the gate could read it. That is what the static half
    below is for.

## The static half: `PC-27` { #the-static-half-pc-27 }

The gate needs a response to judge, and that is what makes it late. `bin/pi-check`'s
`PC-27` asks the same question of the same file with no response, no evidence and no consequence
beyond a red line: **which declared models would the composer have to invent a price for?**

It runs where a wrong answer is free:

- `scripts/install.sh` ends with `bin/pi-check --all`, after `config/models.json` has been generated
  from the provider fragments and before any session exists;
- `scripts/postinstall-verify.sh` runs it again as one of its checks, which is what
  `scripts/update.sh` invokes at the end of an update unless `--no-verify` was passed;
- `bin/pi-check --all` by hand gives the same answer at any later time, which is the only defence
  for a model group added to `models.json` after the install.

Both halves accept exactly the same two declarations, so a config that passes `PC-27` cannot then be
ended by the gate:

```json
"cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3 }   // metered
"cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }      // unmetered, on purpose
```

A gateway quotes **dollars per token** (LiteLLM serves them on `/model/info` as
`input_cost_per_token`); these rates are **dollars per million tokens**, so multiply by 1,000,000
before writing them down. The abort block spells both declarations out verbatim, because the
operator reading it has just lost turn one and should not have to go looking.

## What it will not do

**A deliberate zero stays legal and stays silent, forever.** An endpoint that is genuinely unmetered
is declared with four explicit zeros, and this gate never looks at it again. The rule is not "every
model must be priced" — it is that the zero must be *declared*. The installer offers that answer by
name: for a gateway provider it asks, per model, whether the model is metered, and the "not billed by
the token" answer writes the four zeros for you.

**A note is not a declaration.** Neither this gate nor `PC-27` reads `notes[]`, and
[`test/providers-cost.test.ts`](../configuration/models.md), which governs the provider *fragments*,
stopped accepting one as an explanation for an absent `cost`. All three now want the same thing
written in the same place: a `cost` object beside the model id.

It also answers **no opinion** wherever certainty is unavailable, because ending a session is far
worse to do wrongly than to skip:

| Situation | Why it is not judged |
|---|---|
| `models.json` unreadable or malformed | Somebody else's error to report, and [`doctor`](doctor.md) already does |
| provider not declared in `models.json` | PI knows providers this install never configured; their catalogues are PI's own and already priced |
| provider uses `modelOverrides` and the override says nothing about `cost` | the built-in catalogue's own rate stands, and PI prices its catalogues completely |
| model id absent from the declared catalogue | A `--model` flag, a subagent or a stale id can name a model this file never declared |
| response billed no tokens | No evidence. The gate never fires on a guess |

## Shape

`authorship.ts` is pure — parsed JSON in, verdict out, no PI and no network — so the whole rule is
testable without a gateway or a bill. `index.ts` is the wiring, and it never throws: a gate that
crashes the host while reporting an accounting error has made things worse than the error it found.

The verdict is re-derived from `models.json` on each judgement rather than carried on the model
object, because `models.json` is the only artefact that still holds the distinction the composer
destroys. Nothing downstream branches on a `cost` field to recover it, and nothing should: a cost
object that some readers treat as data and others as a sentinel is how this class of bug starts.

!!! info "`ctx.abort()`, not `ctx.shutdown()`"
    Abort ends the run and leaves the notice on screen. Shutdown exits the process from inside an
    event handler and takes the TUI — and the message — with it. The operator has to be able to read
    why it stopped.

Deduped per `provider/model`, not per session: a second unpriced model is a second undeclared price,
and both entries need fixing.

## Related

- [`models.json`](../configuration/models.md) — the `cost` field, its units, and how to probe a
  gateway's real rates rather than copying a vendor price page
- [`credentials`](credentials.md) — the other module that judges on `message_end` what the provider
  just did
