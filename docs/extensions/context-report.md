# `context-report` — the `/context` command

Registers `/context`. It exists because **PI cannot answer this question**.

Enumerating every slash command in the 0.84.0 binary: there is no `/context`. Occupancy appears only
in the TUI footer as `percent%/window`, which is honest but reads as "4.0 %" when the declared window
is 1 050 000. And `/session` prints a **cumulative billing total** that looks like occupancy and can
be an order of magnitude larger.

## What it reports

| Line | Source | Accuracy |
|---|---|---|
| live context | last assistant `usage.totalTokens` | **exact** — provider-reported |
| preamble | first-turn `cacheWrite` — system prompt + tool schemas + skill catalogue + first message | exact for that turn |
| compactable dialogue | `live − preamble` | an **estimate**, and labelled as one |
| `keepRecentTokens` | `config/settings.json` | exact |
| window / trigger | the resolved `contextWindow` and `contextWindow − reserveTokens` | exact, **with its source** |

The last column is the point. A report that mixes exact and estimated numbers without saying which is
which is how a default gets mistaken for a measurement — the exact failure that motivated
[`compaction`](compaction.md)'s threshold rewrite.

## It fails open, and says so

A report is a diagnostic; a diagnostic that takes the session down is worse than a missing number.
Any throw from PI's accessors degrades to a one-line notice naming the cause.

The "surface once" suppression used elsewhere in this tree is **deliberately not used here**: this is
a command you just typed, so silence on a second invocation would read as success.

## Why the values come from three different objects

Worth knowing if you extend it. `getSystemPromptOptions()` is declared on the **command** context
only — PI treats it as safe only in user-initiated commands. `getSystemPrompt()` and
`getContextUsage()` are on the base context. `getAllTools()` is on the **`ExtensionAPI`**, not on
either context.

All arithmetic and formatting live in `report.ts`, which has no PI import and is therefore
unit-testable.

## Related
[Context windows](../concepts/context-windows.md) · [compaction](compaction.md)
