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
      "maxTotalBytes": 16384,
      "facts": { "enabled": true, "maxEntries": 40, "maxBytes": 8000 }
    },
    "threshold": { "absoluteTokens": 200000, "toleranceRatio": 0.2 }
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

### `pinned.facts` — what the session learned

`sources` re-injects what the project *declares*. `facts` re-injects what the session *established*,
and it exists because the two decay at completely different rates. An instruction file is re-read
from disk every pass, so it survives forever. A discovery lives only in the summary, and the next
compaction summarises that summary rather than the dialogue — so findings fade geometrically while
doctrine does not, and a long session ends up knowing its rules and not its results.

The [`fact`](../extensions/compaction.md#the-fact-tool) tool appends one line to a session-scoped
Markdown file; the file is re-read and restated after every compaction, exactly like `AGENTS.md`.

| Key | Ships | Notes |
|---|---|---|
| `enabled` | `true` | `false` unregisters the `fact` tool and restates nothing |
| `maxEntries` | `40` | Newest 40 entries are restated |
| `maxBytes` | `8000` | Applied after `maxEntries`, dropping from the oldest end |

Both caps are enforced on every read and the block states how many entries it dropped and where the
rest are. That marker is load-bearing: a list quietly cut to fit looks complete, so its *absences*
get read as evidence that something was never established — which sends the agent off to establish
it again, at whatever it cost the first time.

Omitting the key entirely changes nothing. The defaults above apply, and a session that never calls
the tool has no file, so nothing is restated.

**What breaks:** nothing on disk in your project. The file is a sibling of the session transcript
under the agent directory, so it cannot be committed, cannot collide with another session, and is
deleted along with the session. If you want cross-session memory, this is not it and is not meant
to become it.

### `threshold` — the flat 200 000

```json
"threshold": { "absoluteTokens": 200000, "toleranceRatio": 0.2 }
```

One number on every model, whatever its window: the same 200 000 for a 1 000 000-token model, a
200 000-token one and a 60 000-token local GGUF. Nothing has to be run to get it. Every session
start puts it in force and prints one line:

```
[pi-config] compaction: auto-compact: 200K tokens
```

The number used to be `contextWindow − reserveTokens` — PI's own trigger, and therefore a different
number on every model, whichever one you last ran `/autocompact` on. A flat number is a line you
can state once and recognise later.

Three things write this key, and only these three:

| Who | Writes | When |
|---|---|---|
| `session_start` | `200000` | every session, **only when the file does not already say it** |
| `/autocompact` | `200000` | on demand, to put the flat number back after an override |
| `/autocompact <model-id>` | that model's `contextWindow − compaction.reserveTokens` | on demand, an explicit per-model override |

The write-only-on-change guard is what keeps a session-start hook from rewriting a tracked file on
every start — and on every `/new`, which fires `session_start` again. The shipped config already
says `200000`, so a fresh clone writes nothing, ever. A per-model override lasts until the next
session start; one that should survive belongs in this file as a committed change, not in a
command.

!!! warning "Advisory, not a trigger. Setting it to 200 000 does not make anything compact at 200 000"
    PI's actual trigger is `contextTokens > contextWindow − reserveTokens` and 0.84.0 has **no
    absolute-threshold key at all**. `absoluteTokens` is a *stated intent*:
    `extensions/compaction/threshold.ts` compares it against the effective per-model trigger and
    reports the gap. On a 1 000 000-token model the flat number does not move compaction to
    200 000; it makes the harness say, once, that the model compacts 780 000 tokens later than
    intended, and name the one setting that would close it.

With a `reserveTokens` of 20 000 and the shipped tolerance of `0.2`, that comparison verdicts as:

| Declared window | PI's real trigger | Verdict |
|---|---|---|
| below 180 000 | below 160 000 | `window-too-small` — no PI 0.84.0 setting closes this gap |
| 180 000 … 260 000 | 160 000 … 240 000 | `aligned` — within tolerance of 200 000 |
| above 260 000 | above 240 000 | `trigger-too-high` — actionable, see below |

Most of the shipped catalogue is `aligned`, because [its windows are capped at
200 000](../concepts/context-windows.md#the-200-000-cap-and-what-it-costs) already. The models that
are not are the large-window ones, and for those there is exactly one lever — declare the window
you want PI to compact against, in
[`models.json`](models.md#modeloverrides):

```json
"modelOverrides": { "<model-id>": { "contextWindow": 220000 } }
```

`220000` is `200000 + 20000`, so PI's own trigger lands on 200 000 exactly. Two costs before you
reach for it: PI clamps every request's `max_tokens` to `contextWindow − context − 4096`, so a
declared window is also an output ceiling; and a deliberately shrunk window no longer matches what
the endpoint serves. The harness reports this lever and never applies it — it is your decision.

!!! danger "Do not raise `compaction.reserveTokens` instead"
    It is a single **global** scalar, not per model. Setting it to `window − 200000` for a
    1 000 000-token model makes `contextWindow − reserveTokens` negative on every smaller model,
    `shouldCompact()` then returns true at any context size, and the session compacts after every
    assistant message until the loop guard aborts the run. Full argument:
    [Context windows](../concepts/context-windows.md#why-raising-reservetokens-is-not-the-answer).

`threshold.ts` resolves the reserve exactly the way PI does — compaction event → project settings →
global settings → PI default — and **carries the source alongside the value**. That is a direct
consequence of an earlier bug in this repository where a hard-coded PI default was printed as if it
were a measurement, and the resulting advice would have broken three of five providers. A default
must never again be printed as a measurement.

!!! note "The threshold is evaluated after a run; the preflight covers what that misses"
    A single run can issue several provider requests, so the context can pass the window *between*
    two post-run checks. A `before_provider_request` handler refuses a request the declared window
    demonstrably cannot hold, and hands the turn back to PI to compact. It has no keys in this file
    on purpose — its three numbers describe an estimator's error, not an operator's intent. See
    [`compaction` §5](../extensions/compaction.md#5-the-context-window-preflight).

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
    "summarizer": { "kind": "pi", "model": "light", "timeoutMs": 120000 }
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
| `summarizer.model` | `"light"` | A **tier name**. This is the single most common consumer of the `light` tier |
| `summarizer.timeoutMs` | `120000` | |

**What it costs:** one `light`-tier call per session that passed `minTurns`. If your `light` tier is
bound to an expensive model, this is where you will notice. Rebinding `light` in
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
