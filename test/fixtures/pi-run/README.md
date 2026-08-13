# `test/fixtures/pi-run/`

`pi --mode json` event streams, plus the stand-in binary that replays them.

`bin/pi-run` exists because V-01 measured `pi -p --mode json` exiting **0** on a turn that failed
with `401 Invalid token payload`. Its tests must therefore never depend on a network, a model or
llama-swap — the whole point is that the wrapper's verdict is derived from the stream and nothing
else. `fake-pi.mjs` replays one of these files on stdout and exits with a caller-chosen code;
`PI_RUN_PI_BIN` in `bin/pi-run` points at it.

Signal forwarding has no fixture file, because it is a claim about what the **child** does with a
signal rather than about a stream. It is driven by two knobs on `fake-pi.mjs` instead —
`FAKE_PI_SIGNAL_REPORT` (every signal the child received, as JSON, so "it was forwarded, once" is a
fact on disk) and `FAKE_PI_ON_SIGNAL` (`reraise` / `ignore` / `exit`, so the child can die of the
signal, survive it and force the wrapper's SIGKILL escalation, or answer with its own exit code).
Both are documented in that file's header.

## Provenance — read this before trusting a fixture as evidence

Two classes of file live here and they are **not** equally authoritative. The `synthetic-` prefix
is the marker, and it is on the filename rather than only in this table so it survives every way
someone might arrive at one of these files.

### Recorded — derived from the real V-01 run of 2026-08-08

| File | Verdict | What it records |
|---|---|---|
| `auth-401.jsonl` | **20** | The V-01 failure. The assistant `message_end` object is **verbatim** from the run; the event *type* sequence is the recorded one. Field values on the surrounding events (timestamps, session id, user content) are a plausible reconstruction — nothing reads them. |
| `success.jsonl` | **0** | A good turn, built to the recorded shape. Assistant `message_end` carries `stopReason: "stop"`; the user `message_end` carries no `stopReason` at all — the case that must not read as failure. Its type sequence is byte-for-byte `auth-401.jsonl`'s, which is the V-01 finding: **there is no `error` event**, and a failed turn is indistinguishable from a good one by event type alone. |
| `truncated.jsonl` | **21** | `success.jsonl` cut off after the assistant `message_end`: no `turn_end`, no `agent_end`, no `agent_settled`. |
| `user-message-end-only.jsonl` | **21** | A settled stream whose only `message_end` events are the *user*'s, both without `stopReason` — one before and one after where the assistant's would be. Proves the wrapper judges assistant messages only, and that it still refuses to call a run with no assistant output a success. |
| `assistant-no-stop-reason.jsonl` | **22** | A complete stream whose assistant `message_end` carries no `stopReason` field. The field-rename canary. |

### Recorded — from the V-08 compaction-loop run of 2026-08-08

V-08 measured that an extension has **no** in-process abort path in
headless mode: `ctx.shutdown()` and `ctx.abort()` both return `undefined` and the run carries on and
exits **0**. The wrapper's guard is the FAIL branch of that step, and these two files are the run it
failed on — a live `pi -p --mode json` against a local model whose `contextWindow` was cut to 8000,
with `extensions/compaction` configured to trip on the first pass (`maxNonReducingPasses: 1`,
`minReductionRatio: 1.5`, `headlessExitCode: 0`). The `1.5` is why the record says "150.0 % floor":
an impossible floor is what makes a single overflow pass trip deterministically without a long
session. `headlessExitCode: 0` suppresses the extension's own `process.exit`, leaving exactly the
shape the wrapper has to catch — a tripped guard that `pi` still reports as success.

| File | Verdict | What it records |
|---|---|---|
| `compaction-loop.jsonl` | **23** | The real stream, in order, including `compaction_start`, the `entry_appended` whose `entry.customType` is `pi-config.compaction-loop`, and `compaction_end` with `aborted: true`. It ends `agent_settled` with no failing assistant message — **on the stream alone this run is a success**, which is the whole reason 23 exists. Three edits, all lossless for this wrapper: the 1026 `message_update` events were dropped, `text`/`thinking` strings over 80 chars were replaced with a marker, and the upstream `message.responseId` (a `chatcmpl-…` token, which PC-06 reads as a literal secret by shape) with another. `bin/pi-run` reads none of them. |
| `compaction-loop.sentinel.json` | — | **Verbatim** copy of the sentinel that run wrote to `$XDG_STATE_HOME/pi-config/compaction-loop/019fe051-….json`. Not a stream: `fake-pi.mjs` copies it into place mid-run through `FAKE_PI_SENTINEL_FROM`/`_TO`, reproducing the ordering the extension actually has — `pi.appendEntry` first, then the sentinel (`extensions/compaction/index.ts:288,308`). |

### Synthetic — hand-authored from the source, never observed

**No live run produced any of these, and for the retry ones no live run realistically could.**
`isRetryableAssistantError` (`@earendil-works/pi-ai/dist/utils/retry.js:165`) returns false unless
`stopReason === "error"` **and** the text matches its transient-failure pattern — `429`, `500`-`504`,
`overloaded`, `rate limit`, socket/DNS/timeout shapes. V-01's `401 Invalid token payload` matches
none of them, so the endpoint that produced the recorded failure is precisely the one that can
never produce a retry. Provoking a real one means an upstream that is overloaded on demand.

They are therefore written against the source, and every event `bin/pi-run` actually reads
(`type`, `message.role`, `message.stopReason`, `message.errorMessage`, `message.provider`,
`message.model`, `agent_end.willRetry`) is placed exactly where the source puts it:

- `agent_end` is emitted as `{...event, willRetry: this._willRetryAfterAgentEnd(event)}` —
  `@earendil-works/pi-coding-agent@0.84.0`, `dist/core/agent-session.js:366`.
- `_willRetryAfterAgentEnd` walks `event.messages` backwards and returns on the first assistant
  message, so the flag speaks for exactly one message (`:401-413`).
- The failed attempt's `message_end` precedes its `agent_end`; the retry re-enters the agent loop
  and emits a fresh `agent_start` (`pi-agent-core/dist/agent-loop.js:49,67`).
- `agent_settled` is emitted once, from the `finally` of `_runAgentPrompt`, after the whole retry
  loop (`agent-session.js:744-756`).

Events pi-run does **not** read (`auto_retry_start`, `auto_retry_end`, `turn_start`, `turn_end`)
are included for realism and their exact placement is a best-effort reconstruction.

| File | Verdict | What it constructs |
|---|---|---|
| `synthetic-retry-then-succeed.jsonl` | **0** | A `503` error `message_end`, then `agent_end` with `willRetry: true`, then a second attempt that ends `stop`. The error is reported as a note, not a failure. |
| `synthetic-retry-then-exhaust.jsonl` | **20** | The same first attempt, then a second that errors again and a final `agent_end` with `willRetry: false`. The first error is suppressed, the second is a failure. |
| `synthetic-error-then-truncated.jsonl` | **20** | An error `message_end` with **no** following `agent_end` and no `agent_settled`. The anti-fail-open case: suppression needs positive evidence of a retry, and silence is not evidence. The error text is deliberately retryable-shaped so that a naive "wait for an `agent_end`" implementation would swallow it. |
| `synthetic-two-errors-one-retried.jsonl` | **20** | Two assistant error `message_end`s in one window, then `agent_end` with `willRetry: true`. Only the last is suppressed; the earlier one is a failure, because that is what `_willRetryAfterAgentEnd` actually claims. |
| `synthetic-aborted.jsonl` | **24** | An assistant `message_end` with `stopReason: "aborted"` and no `errorMessage`, then a clean `agent_end`/`agent_settled`. PI's own print mode exits 1 on an abort; `--mode json` exits 0. |
| `synthetic-compaction-loop-sentinel-only.jsonl` | **23** with a sentinel, **0** without | `compaction-loop.jsonl` with the `entry_appended` line removed, so the sentinel on disk is the only trigger left. Not a fiction: `writeSentinel` is best-effort and returns `null` when the state root is unwritable (`extensions/compaction/index.ts:268`), and the mirror case — a sentinel that never lands — is why the wrapper watches the stream too. This file is the other half, and it is also the only way to test the stale-sentinel and kill paths without a race. |
| `synthetic-session-id-needs-sanitising.jsonl` | **23** with a sentinel | `success.jsonl` with the session id replaced by `weird/id one:2026`. PI has never been observed to emit an id like that — every recorded one is a UUIDv7 — but the extension sanitises to `[A-Za-z0-9._-]` before naming the file (`extensions/compaction/index.ts:261`), and `bin/pi-run` restates that sanitiser rather than importing it. Two independent copies of a rule need a test that fails when they diverge. |

### The `session` line, corrected 2026-08-08

Every `.jsonl` here opens with the `session` event, and until V-08 it carried an invented shape
(`sessionId`, `model`, `provider`). The real one, from both live runs, is
`{"type":"session","version":3,"id":…,"timestamp":…,"cwd":…}` — the id is `id`, and no model or
provider appears. That was harmless while nothing read the event; the loop guard reads `event.id` to
know which sentinel is its own, so all ten pre-existing fixtures were corrected to the measured
shape. `id` was verified identical to `ctx.sessionManager.getSessionId()` inside the extension.
