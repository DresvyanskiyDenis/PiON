# Session lifecycle — compaction, digests, tasks, quota

Four small tracked files, none of them asked about during installation. Each is safe to edit in
place, and each has one key that is worth understanding before you touch it.

---

## `compaction.json`

Read by [`extensions/compaction`](../extensions/compaction.md). This file is **not** PI's
compaction settings — those are `compaction` in [`settings.json`](settings.md#compaction). This one
configures the loop guard, the pinned-instruction re-injection, and the advisory threshold.

```json
{
  "compaction": {
    "loopGuard": {
      "maxNonReducingPasses": 3,
      "minReductionRatio": 0.15,
      "minEntriesBetweenPasses": 2,
      "headlessExitCode": 91
    },
    "instructions": { "enabled": true },
    "pinned": {
      "enabled": true,
      "sources": ["AGENTS.md", "CLAUDE.md"],
      "maxBytesPerSource": 4096,
      "maxTotalBytes": 16384
    },
    "threshold": { "absoluteTokens": 180000, "toleranceRatio": 0.2 }
  }
}
```

### `loopGuard`

The failure this exists for: compaction fires, reclaims almost nothing, and fires again — forever,
burning a summarisation call each time. It is what an over-large `reserveTokens` produces (see
[settings.json](settings.md#compaction)).

| Key | Ships | Meaning |
|---|---|---|
| `maxNonReducingPasses` | `3` | Consecutive passes that failed to reduce enough, before the guard trips |
| `minReductionRatio` | `0.15` | A pass counts as "reducing" only if it removed ≥ 15 % of the context |
| `minEntriesBetweenPasses` | `2` | Passes closer together than this are counted as one loop, not two attempts |
| `headlessExitCode` | `91` | The code the extension exits with when it trips a headless run |

!!! warning "Raising `maxNonReducingPasses` does not fix anything"
    If the guard is tripping, the context window declaration is wrong, or `reserveTokens` is. Read
    [Context windows](../concepts/context-windows.md). Raising the pass count just makes the loop
    longer and more expensive before it stops.

The guard cannot stop a headless run from inside PI — measured against 0.84.0, `ctx.shutdown()` and
`ctx.abort()` both return `undefined` and do nothing inside a `session_before_compact` handler.
So it writes a sentinel and [`bin/pi-run`](../operations/cli.md#pi-run) exits **23**. That split is
explained in [Architecture](../concepts/architecture.md#the-process-boundary).

### `pinned`

After a compaction, the summary replaces the dialogue — and with it, the instructions the agent
had absorbed from `AGENTS.md`. `pinned` re-injects those sources so the rules survive.

| Key | Ships | Notes |
|---|---|---|
| `enabled` | `true` | |
| `sources` | `["AGENTS.md", "CLAUDE.md"]` | Filenames looked for in the project. Add your own convention if you use one |
| `maxBytesPerSource` | `4096` | Truncation cap per file |
| `maxTotalBytes` | `16384` | Cap across all sources |

**What breaks:** raising the caps eats the budget compaction just reclaimed. If your `AGENTS.md` is
larger than 4 KB, the right fix is a shorter `AGENTS.md` — everything past the cap was not
surviving compaction anyway.

### `threshold`

```json
"threshold": { "absoluteTokens": 180000, "toleranceRatio": 0.2 }
```

**Advisory, not a trigger.** PI's actual trigger is
`contextTokens > contextWindow − reserveTokens` and it has no absolute-threshold key at all. This
block is what `extensions/compaction/threshold.ts` compares the *effective* trigger against, so it
can warn you once when the two disagree by more than `toleranceRatio`.

That module resolves the reserve exactly the way PI does — compaction event → project settings →
global settings → PI default — and **carries the source alongside the value**. That is a direct
consequence of an earlier bug in this repository where a hard-coded PI default was printed as if it
were a measurement, and the resulting advice would have broken three of five providers. A default
must never again be printed as a measurement.

---

## `digest.json`

Read by [`extensions/digest`](../extensions/digest.md). Writes an end-of-session summary.

```json
{
  "digest": {
    "enabled": true,
    "minTurns": 2,
    "maxTranscriptBytes": 200000,
    "outputDir": "~/.pi/agent/digests",
    "summarizer": { "kind": "pi", "model": "cheap", "timeoutMs": 120000 }
  }
}
```

| Key | Ships | Notes |
|---|---|---|
| `enabled` | `true` | **`false` turns digests off entirely.** The one-key answer to "stop writing these files" |
| `minTurns` | `2` | Sessions shorter than this are not worth summarising |
| `maxTranscriptBytes` | `200000` | Larger transcripts are truncated before summarising |
| `outputDir` | `~/.pi/agent/digests` | Plain Markdown, one file per session |
| `summarizer.kind` | `"pi"` | Summarise by calling the agent itself |
| `summarizer.model` | `"cheap"` | A **tier name**. This is the single most common consumer of the `cheap` tier |
| `summarizer.timeoutMs` | `120000` | |

**What it costs:** one `cheap`-tier call per session that passed `minTurns`. If your `cheap` tier is
bound to an expensive model, this is where you will notice. Rebinding `cheap` in
[`routing.json`](routing.md) is a better fix than turning digests off.

---

## `tasks.json`

Read by [`extensions/tasks`](../extensions/tasks.md), which sits on top of the task-list package.

```json
{ "tasks": { "nudgeEveryTurns": 6, "staleAfterTurns": 12 } }
```

| Key | Ships | Meaning |
|---|---|---|
| `nudgeEveryTurns` | `6` | How often the agent is reminded to update its task list |
| `staleAfterTurns` | `12` | A task left `in_progress` this long is flagged as stale |

Lower `nudgeEveryTurns` if the agent drifts from its plan; raise it if the reminders are eating
context on short tasks. The task list is replayed from the session transcript and is **not**
persisted to disk, so nothing here survives a session.

---

## `quota.json`

Read by [`extensions/quota`](../extensions/quota.md). Only meaningful for a provider that publishes
a usage endpoint.

**Generated** from the tracked `config/quota.default.json`; the installer sets `enabled` from one
question at the tools step.

```json
{
  "quota": {
    "enabled": false,
    "ttlMs": 300000,
    "timeoutMs": 10000,
    "tokenFile": "~/.config/pi/copilot-quota-token.json",
    "preflight": { "enabled": true, "thresholdPct": 15 }
  }
}
```

| Key | Ships | Meaning |
|---|---|---|
| `enabled` | `false` | `true` turns on the meter. Only some providers publish a usage API; on one that does not, the meter renders as a dash and costs nothing |
| `ttlMs` | `300000` | Five-minute cache. The usage endpoint is rate-limited; do not lower this casually |
| `timeoutMs` | `10000` | A slow quota endpoint must never delay a turn by more than this |
| `tokenFile` | `~/.config/pi/copilot-quota-token.json` | `0600`. A **separate, read-only** credential — never the chat token |
| `preflight.enabled` | `true` | Warn before a turn when the remaining budget is low |
| `preflight.thresholdPct` | `15` | The warning line |

!!! danger "The meter warns. It never intercepts."
    When the budget is actually gone, the **provider's own error** surfaces unmodified through the
    fail-loud path. The meter does not block a turn, does not substitute a provider, and does not
    retry. That is the same standing rule as
    [`onProviderError`](routing.md#onprovidererror).

!!! warning "The token file is recorded when touched — not protected"
    `SEC-QUOTA-TOKEN` matches any path ending `quota-token.json`, but since 2026-08-15 it writes a
    `guard.observed` entry and permits the call rather than refusing it. Keep the file `0600` and
    scope the credential accordingly: it is a classic PAT with a read-only user scope; a
    fine-grained token is rejected by the usage endpoint. Details on
    [quota](../extensions/quota.md).

If your provider has no such endpoint, set `enabled: false` and the extension degrades to a
one-line "no quota source configured" status instead of failing.

---

## Related

- [Context windows](../concepts/context-windows.md) — before touching any compaction number
- [`settings.json`](settings.md#compaction) — PI's own three compaction keys
- [Exit codes](../reference/exit-codes.md) — where `23` and `91` come from
