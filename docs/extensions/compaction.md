# `compaction` — loop guard, keep/drop, pinning, threshold

Four parts, in the order they matter. Configured by
[`config/compaction.json`](../configuration/sessions.md#compactionjson); PI's own three keys are in
[`settings.json`](../configuration/settings.md#compaction).

Registers `/compaction-status`.

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

## 4. Threshold reporting

PI has **no absolute-count key**. The effective trigger is `contextWindow − reserveTokens`, which is
per-model. `threshold.ts` computes it for the active model, classifies the gap against your declared
`absoluteTokens`, and says so **once ever** per `(model, window, reserve, absolute)` tuple rather
than once per session.

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
[`compaction.json`](../configuration/sessions.md#compactionjson) ·
[Exit codes](../reference/exit-codes.md) · [context-report](context-report.md)
