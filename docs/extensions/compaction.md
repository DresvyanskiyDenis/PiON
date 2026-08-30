# `compaction` — loop guard, keep/drop, pinning, threshold, preflight

Five parts, in the order they matter. Configured by
[`config/compaction.json`](../configuration/sessions.md#compactionjson); PI's own three keys are in
[`settings.json`](../configuration/settings.md#compaction).

Registers `/compaction-status`, `/autocompact` and the `fact` tool.

## 1. The loop guard

N consecutive non-reducing automatic compaction passes abort the run with a typed error. Shipped:
three passes, a 15 % minimum reduction ratio, and a minimum gap of two entries between passes.

The failure it prevents is compaction firing, reclaiming nothing, and firing again — burning a
summarisation call each time, forever.

## 2. The keep/drop contract

Reaches PI's summariser as `customInstructions`, **appended** to PI's structured template, never
replacing it. Replacing it would discard PI's own knowledge of its transcript format in order to add
an opinion about content.

## 3. Pinned-block regeneration

Instruction sources — `AGENTS.md` and friends — are **regenerated** after a compaction rather than
protected in place. Regeneration is the only honest reading of "pin a region": PI's summariser
rewrites the transcript, and a region you asked it not to touch is a request, not a guarantee.
Regenerating is a guarantee.

Capped at 4 KB per source and 16 KB total, because the budget being re-spent is the one compaction
just reclaimed.

### Facts, and why they need the same treatment

Regeneration covers what the project *declares*. Nothing covered what the session *learned*, and
that gap is not symmetric with the first: an instruction file is re-read from disk on every pass and
so survives indefinitely, while a discovery lives only inside the summary — and each compaction
summarises the previous summary rather than the original dialogue. Detail does not fade linearly
under that arrangement, it fades geometrically, and it fades in one direction. A long session ends
up holding its rules perfectly and its results barely at all.

The symptom is an agent paying twice. The base URL that was confirmed by hand in the first hour is
gone by the ninth compaction, so it gets confirmed again — another request, another remote run,
another round of the operator repeating a correction he already gave.

`facts` applies regeneration to a second source. `extensions/compaction/facts.ts` owns an
append-only Markdown file, one fact per line carrying an ISO timestamp, the fact, and how it was
established. It is restated after each compaction beside the pinned block.

The file is a sibling of the session transcript under the agent directory, and that single choice
buys three properties that are each requirements rather than conveniences:

- **Outside every working tree.** It cannot be committed by accident, which matters because facts
  are exactly the content that quotes hostnames, identifiers and raw error bodies.
- **Keyed by session id.** A parent and its subagent, or two terminals in one project, cannot write
  into each other's file.
- **Session-scoped.** It dies with the session. This is not a memory system: no store, no index, no
  retrieval, nothing accumulating across sessions for nobody to curate.

Both caps — 40 entries and 8 KB, in
[`compaction.json`](../configuration/sessions.md#pinnedfacts-what-the-session-learned) — are applied
on every read, oldest first, and the block states how many entries were dropped and names the file
holding the rest. A silently shortened list is worse than no list, because it reads as complete and
its absences then look like evidence.

### Two kinds: `fact` and `ruled_out`

A file that holds only outcomes is a record of what worked. The other half — every approach that was
tried and abandoned — used to leave no trace at all, so after a compaction the session no longer
remembered refusing a dead end and walked back into it at full cost.

```
fact(kind: "ruled_out",
     fact: "reading the schema from the catalog API",
     provenance: "403 for this token, three attempts, same result")
```

`kind` defaults to `"fact"`. For `"ruled_out"`, `provenance` is **the reason, and it is mandatory** —
the call is refused without one, because an abandonment carrying no reason is exactly the record a
later turn talks itself back out of. The two shapes on disk:

```
- `2026-08-30T16:36:54.000Z` the base URL is the /openai/v1 form _(established: curl, 200 OK)_
- `2026-08-30T16:36:54.001Z` **ruled out:** the mlflow/v1 form _(because: INVALID_PARAMETER_VALUE)_
```

They stay in **one chronological list**. An approach was ruled out at a point in the work, and
splitting the classes into two blocks would lose the order that explains why. The restatement marks
the class, counts the ruled-out entries and states the obligation that comes with them: do not retry
one without new evidence that its stated reason no longer holds, and read them before further
fix-work. `SYSTEM.md` carries the same rule on the writing side — abandoning an approach *is* a fact.

Both classes are capped by the same rule, oldest first, neither privileged nor sacrificed. When the
caps drop ruled-out entries the marker says how many, because an approach missing from the block
must not read as an approach that was never refused.

### The `fact` tool

```
fact(fact: "…", provenance: "…")
```

`provenance` is optional in the schema and effectively mandatory in practice: a fact without it is
recorded as `not stated`, and a later turn that cannot tell a verified thing from an assumed one
will re-derive it anyway. Pass the command that proved it, a `file:line`, a run id, or
`"operator correction"`.

The reply names the entry twice over:

```
recorded fact 13 of 14 in this session
```

The first number is that entry's **position in the file**, read back after the write; the second is
the file's count. They differ when another `fact` call appended in parallel — which is the whole
reason the reply is not a single count. A count of the file taken *after* the append answers the
same number to every caller whose write landed before any of them re-read, and "we both appended" is
then indistinguishable from "one of us was overwritten". Nothing is in fact lost (each append is one
write on an `O_APPEND` descriptor, atomic against the others), but a report that cannot tell those
two apart is blind to the worse one. Two entries recorded in the same millisecond are written one
millisecond apart so each line stays addressable, and the file header is created with `wx` so N
racing first writers cannot prepend N headers.

It is a tool rather than an instruction to keep a notes file by hand because hand-editing is the
step that gets skipped under time pressure — and time pressure is exactly the condition under which
a fact was expensive enough to be worth keeping. `SYSTEM.md` carries the doctrine that makes it
fire, which is the load-bearing half: the mechanism without it is a tool nobody calls.

## 4. Threshold reporting

The declared threshold is a **flat 200 000 tokens on every model**. `session_start` puts it in
force and prints one line — `auto-compact: 200K tokens` — writing `config/compaction.json` only
when the file does not already say it, which the shipped config does.

PI has **no absolute-count key**. The effective trigger is `contextWindow − reserveTokens`, which is
per-model, so the flat number is a *stated intent*, not a lever: it does not make a
1 000 000-token model compact at 200 000. `threshold.ts` computes the real trigger for the active
model, classifies the gap against the declared `absoluteTokens`, and says so **once ever** per
`(model, window, reserve, absolute)` tuple rather than once per session. The verdict band, the one
lever that closes a `trigger-too-high` gap, and what that lever costs are on
[`compaction.json`](../configuration/sessions.md#threshold-the-flat-200-000).

!!! danger "Read this module's own history before changing a number"
    An earlier version printed advice recommending a `reserveTokens` value that, applied globally,
    would have broken three of five providers. Three faults were stacked: a **hard-coded PI default
    printed as a measurement**, a **global scalar treated as per-model**, and a coverage record
    marking a non-implementable approach as applied.

    The fix is not the arithmetic. The module now resolves the reserve exactly the way PI does —
    compaction event → project settings → global settings → PI default — and **carries the source
    alongside the value**, so a default can never again be printed as a measurement.

    The only honest per-model lever is
    [`modelOverrides.<id>.contextWindow`](../configuration/models.md#modeloverrides). Full argument:
    [Context windows](../concepts/context-windows.md).

### `/autocompact` — the flat number, or one model's own trigger

The argument chooses between two intents, and **neither moves a trigger**. Both persist to
`config/compaction.json`.

| Form | Writes | Reads |
|---|---|---|
| `/autocompact` | the flat `200000` | nothing — no catalogue, no reserve, no arithmetic that can refuse |
| `/autocompact <model-id>` | that model's `contextWindow − reserveTokens` | `config/models.json` and the resolved reserve |

The no-argument form is what `session_start` already keeps written, so it exists mainly to put the
flat number back after an override. The named form is for the case where matching one model exactly
is the point rather than holding the line at 200 000 — and the next session start puts the flat
number back, so an override that should survive belongs in the file as a committed change.

The named form writes **`contextWindow − reserveTokens`**, not the window. That is the trigger PI
already uses, so the declared absolute becomes exactly what `shouldCompact()` does and the verdict
reads `aligned`. Writing the window itself would state an intent PI can never meet: the trigger is
always `reserveTokens` below it, so the report would say `window-too-small` — and on a 64k model,
with the 16384-token default reserve, that is a 26 % divergence, past the 20 % tolerance, with a
remedy line that correctly says no PI 0.84.0 setting closes the gap.

The window is read from `config/models.json` — **declared, never probed**, because that file carries
this repo's deliberately understated windows. A model id that two providers declare differently is
settled by the session's own provider and refused otherwise, naming both candidates; a named model
the catalogue does not declare is refused rather than guessed.

The write is textual and re-parsed before it is offered: re-serialising the config would reformat 14
lines to change one number, and `config/compaction.json` is tracked.

## 5. The context-window preflight

Auto-compaction is evaluated **after a run**. That leaves one case it structurally cannot catch: a
single run issues several provider requests, the context grows between two post-run checks, and one
of those requests goes out already larger than the declared window. The provider does not
necessarily refuse it — an OpenAI-compatible gateway answered one such request with a `200` and an
empty body, which this harness classifies as
[`empty-response`](../configuration/routing.md#onprovidererror), which killed the turn. Every number
needed to prevent it was in the process before the request was assembled.

So a `before_provider_request` handler estimates the outgoing prompt and compares it against
`ctx.model.contextWindow`. Over the bar, the request is **not sent**:

```
[pi-config] compaction: refused a request this harness estimates at ~273110 tokens against
<provider>/<model>'s declared 200000-token window (~37% over, estimate is chars/3.5 on the
assembled body). Nothing was sent: an over-window request to this fleet comes back as a 200 with
an empty body, not as an error. Compaction runs next and the turn continues.
```

!!! note "A harness decision, filed as one"
    The refusal is written to the session as a `context_preflight` entry, never as a
    `provider_failure`, and it never carries the `[pi-config] provider call failed:` marker
    `extensions/dispatch/failure-slot.ts` greps for. Nothing failed, because nothing was sent —
    and a harness refusal filed in the channel an operator greps for provider failures is how you
    end up debugging a gateway that was working.

### The estimate, and the bound on it

There is no tokenizer here. The estimate is the total length of the **string leaves** of the
assembled request body — not `JSON.stringify().length`, which counts keys, braces and escapes no
tokenizer ever sees — divided by **3.5 characters per token**. English prose runs about 4, code and
JSON about 3, and this harness's contexts are mostly the latter; PI's own internal estimator uses a
flat 4, which on the incident above would have read ~202 000 and missed it.

The residual error is roughly ±15 % in both directions. That is why the bar is not the window but
**`contextWindow × 1.05`** — 210 000 tokens on a 200 000 window. A prompt sitting at 98 % of the
window, where the estimator's error genuinely could decide the verdict, is left to auto-compaction,
which by then has long since fired.

### Why it cannot fire before auto-compaction

PI compacts at `contextTokens > contextWindow − reserveTokens`, i.e. always *below* the window. The
preflight only ever acts *above* it, plus the 5 % tolerance. At any size where auto-compaction has
something to say, the preflight is silent: it cannot trigger a compaction that was not going to
happen anyway, and cannot spend a summarisation call the reserve would have spent.

Refusing is also all it does. The refused turn returns to PI, whose own post-run check now sees a
context demonstrably over the window, compacts, and continues. Calling `ctx.compact()` here as well
would put a second compaction against the same context — the exact shape §1's loop guard exists to
shoot down.

This is also the one place in this module where `ctx.abort()` works. [The section
below](#an-extension-cannot-abort-a-headless-run) records that it is a no-op on the automatic
compaction paths, because `activeRun` has already been cleared by then. A `before_provider_request`
handler is the opposite case: it runs *inside* the active run, immediately before the HTTP call, so
the abort lands on the very request being assembled.

### It gives up rather than loop

Two consecutive refusals per session is the budget — one for the request that was over, one for a
request that is *still* over after the compaction. A third is let through, loudly, naming the real
fix (`/compact` with instructions, a new session, or a `contextWindow` that matches what the
endpoint serves). A doomed request whose failure is visible beats a session that never sends
anything and never says why. The streak resets at the first request that fits.

!!! warning "These three numbers are constants, not config keys"
    `CHARS_PER_TOKEN`, `OVER_WINDOW_TOLERANCE` and `MAX_CONSECUTIVE_REFUSALS` live in
    `extensions/compaction/preflight.ts`. They describe the estimator's own error; an operator
    tuning them without new measurements is tuning the wrong thing. The lever that is yours is
    [`modelOverrides.<id>.contextWindow`](../configuration/models.md#modeloverrides).

## An extension cannot abort a headless run

Answered against the shipped code of 0.84.0 rather than the docs. Both documented candidates fail,
and the second fails for a reason the runbook did not anticipate:

- **`ctx.shutdown()`** resolves to an optional handler that print mode's `bindExtensions()` call
  never passes. It is a no-op under `-p` and `--mode json`. Interactive mode does bind one.
- **`ctx.abort()`** falls through to `this.activeRun?.abortController.abort()`. The pre-compaction
  event is emitted from `_runAutoCompaction()`, called by `_handlePostAgentRun()` — *between*
  `prompt()` and `continue()` — and `finishRun()` has already cleared `activeRun` by then. So on the
  automatic paths **`ctx.abort()` is a no-op in every mode**, not only headless.

The only working exit is `process.exit()` from inside the handler, and that is immediate: PI's own
teardown event never fires and no other extension gets to clean up.

So the guard is split across the process boundary. It writes a sentinel **and** appends a session
entry, and [`bin/pi-run`](../operations/cli.md#pi-run) watches for either and exits **23**. Two
signals rather than one, because writing the sentinel is best-effort and returns null when the state
root is unwritable — a sentinel-only wrapper would report success in exactly the case where the
guard could not speak.

## Related
[Context windows](../concepts/context-windows.md) ·
[`onProviderError`](../configuration/routing.md#onprovidererror) ·
[`compaction.json`](../configuration/sessions.md#compactionjson) ·
[Exit codes](../reference/exit-codes.md) · [context-report](context-report.md)
