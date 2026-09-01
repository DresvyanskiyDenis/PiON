# `credentials` — token caching and provider errors

Two things that are the same subject: what it takes to talk to a model, and what happens when that
fails.

!!! info "There used to be a third: the local lane"
    This module also registered a `local` provider — whatever OpenAI-compatible server was running
    on loopback — with its own discovery budget, a `/v1/models` warm-up ping at `session_start`, and
    a `baseUrl` that deliberately outranked `models.json`. Owner decision, 2026-08-15: the provider
    set is exactly `github-copilot`, an OpenAI-compatible gateway and `databricks`, and that lane was
    deleted. A server on loopback is still perfectly reachable — configure it through
    [`openai-compatible`](../configuration/openai-compatible.md) with a `127.0.0.1` base URL, which
    needs no extension and no environment variable.

    What went with it is worth naming, because it was the only instance of each: the one place an
    extension's `baseUrl` could win over `models.json`, and the one `session_start`/`session_shutdown`
    handler in this module. Both are gone; this module now registers nothing and arms no handler.

## (a) Cached command credentials

No code here — `config/bin/dbx-token-cached` is the whole implementation, referenced from
`models.json` as `"apiKey": "!$HOME/bin/dbx-token-cached"`.

It exists because **PI re-executes an `!command` credential on every request with no TTL of its
own**. An unwrapped CLI token call costs one OAuth round trip per LLM call. The wrapper puts a TTL
cache (a `0600` file in a `0700` directory) in front of it, turning that into a file read.

## (b) Prompt-cache retention

`PI_CACHE_RETENTION=long` is an env var `pi-ai` reads as a fallback in every API module whenever
the caller passes no explicit `cacheRetention` — and nothing in this repo ever does, so that
variable alone decides the retention tier for every provider, on every call, if it is set at all.
Two paid products ride on it: `prompt_cache_retention: "24h"` on an OpenAI-shaped route, and
`cache_control: {type:"ephemeral", ttl:"1h"}` on an Anthropic-shaped one. Both are gated on a
provider's `compat.supportsLongCacheRetention`, and that flag **defaults to true** wherever a
provider's `compat` block says nothing about it — so setting the variable opts every unprobed
route into a product nobody chose for it.

`extensions/lib/cache-retention.ts` takes that decision away from the environment. `register()`
reads `config/models.json` and honours `PI_CACHE_RETENTION=long` only when **every** configured
provider declares an explicit `compat.supportsLongCacheRetention` boolean **and** at least one of
them opts in. Any other state — a provider that says nothing, a `models.json` that cannot be
read, or every provider pinning `false` — rewrites the variable to `short` before the first
provider request and says why on the log sink. Silence is not consent: installing a new provider
fragment without a retention decision does not quietly opt it in, it takes the switch away from
routes that had already decided.

The pin is a rewrite, not a deletion, so a bash tool, a hook, or a dispatched child reading
`PI_CACHE_RETENTION` sees the effective value rather than a claim this module overrode. Opting a
route in for real means adding `"compat": {"supportsLongCacheRetention": true}` to that provider
in your own (gitignored) `config/models.json`, after confirming the gateway actually honours the
field — not by editing a tracked template.

## (c) Provider error surfacing

This is what replaced the cancelled failover item. A failed provider call names the provider, the
model, the error class and the message, keeps the cause chain, and **the turn aborts**:

```text
[pi-config] provider call failed:
  provider    : <name>
  model       : <id>
  error class : auth | quota | network | model-not-found | policy | empty-response
  message     : <upstream text>
  caused by   : <cause chain>
```

No substitution, no retry into a *different* provider, no silent degradation — see
[one retry, to the same endpoint](#one-retry-to-the-same-endpoint) for the one thing that is
retried. Classification and rendering live in `extensions/lib/provider-error.ts`.

Five of the six classes are read off the provider's error text. The sixth, `empty-response`, is
recognised by the **shape** of a successful-looking turn: HTTP 200, zero content parts, a
`stop`-family finish reason and zero usage. Left unreported it is not an error anywhere in the
stack — the turn looks ordinary, the retry predicate skips it, and a headless run exits 0 with no
output — so it is reported here and the headless exit code is forced non-zero, which is how a
dispatcher hears about it at all. The same headless run also has no TUI and its stderr is often
unread until well after it exits, so an abort in that mode is additionally appended, as one JSON
line (timestamp, pid, provider, model, class, retry counters, message), to a durable log at
`providerAbortLogPath()` (`extensions/lib/paths.ts`) — a script that only checked the exit code
still has somewhere to find out why. See
[`onProviderError`](../configuration/routing.md#onprovidererror).

## One retry, to the same endpoint

`network` and `empty-response` get **one** more attempt before the abort. Everything else — `auth`,
`quota`, `model-not-found`, `policy` — aborts on the first failure, because those four are answers
about the request and asking again gets the same answer a round trip later. The classes and the
budget come from
[`onProviderError.retry`](../configuration/routing.md#retry-the-two-classes-that-are-weather-not-a-verdict);
`maxAttempts: 0` turns it off.

This is still not failover: same provider, same model, and the abort is still where every class
ends up. What it buys is the case the abort is worst at — an `empty-response` inside a dispatched
sub-agent, which destroys paid work rather than a turn an operator can retype.

The re-issue is a queued message with `triggerTurn`, and it is **displayed**. That is deliberate: a
turn that silently ran twice is indistinguishable from a model that repeated itself, and the
transcript is where that question gets asked. PI's own auto-retry cannot cover this — it requires
`stopReason === "error"`, and an `empty-response` arrives as an ordinary `stop`.

The budget is per failure **streak**, cleared by the first turn that works and by a session switch,
so a transient failure an hour after a recovered one starts from a full budget. Because that budget
is tracked per *class*, a streak that changes class mid-run gets a fresh one — `network` exhausting
its attempt must not silently deny a later, unrelated `empty-response` its own. That fresh start is
itself bounded, per session, by `maxStreakRestarts` (default 2): a streak that keeps trading between
classes stops getting re-armed once the cap is spent, so a class ping-pong cannot retry forever.

## Field notes: an empty-200 investigation (2026-08-14)

An investigation against a production OpenAI-compatible gateway (LiteLLM), run because
`empty-response` was firing at a rate worth explaining rather than shrugging at. It is recorded
here, with the tenant-specific pieces stripped, because the shape of the failure and the way two
plausible-sounding stories about it turned out to be wrong are useful independently of who was
running the gateway.

**Reproduced 549 times** against the live gateway (798 probe requests total; window ~11 minutes).
**Streaming: 211 ok / 549 empty / 0 errors. Non-streaming: 36 ok / 0 empty / 2 × HTTP 429.** The
asymmetry is the strongest single fact in the investigation: the streaming path fails *silently* at
a high rate, and the non-streaming path on the same deployment never fails silently at all — it
either succeeds or reports a real error. Not model-specific either: empty responses were seen
across more than one model group in the same session history.

**Four stories were tested and refuted:**

- **Idle gap / cache expiry.** If this were a stale-connection or cache-expiry effect, the gap since
  the last healthy turn should predict it. It did not: the gap was 0–4 s in every production
  failure, and several failed on a model's very first turn in the session, with no predecessor to
  have gone idle after.
- **Prompt size threshold.** If this were a size effect, larger prompts should fail more. The
  opposite pattern was observed — small control requests went empty while a much larger request in
  the same session succeeded seconds apart.
- **Concurrency.** Every production failure had exactly one request in flight at the time it
  failed. A separate, larger sweep recording zero failures was cited at one point as evidence about
  concurrency; it wasn't — that sweep simply ran outside a degraded window, which says nothing about
  whether concurrency matters.
- **The response id's form is not a failure marker.** The two id shapes a request can come back
  with (a gateway-issued id vs. an upstream-shaped one) turned out to be decided by something
  unrelated to health: whether the request body carried `tools`. Every agent turn carries `tools`,
  so the harness is permanently on the same side of that split regardless of whether the call
  succeeded — the id form has zero discriminating power over failure. (Zero prompt/completion
  tokens in the usage report is the companion refuted claim, and it is recorded in
  [`onProviderError`](../configuration/routing.md#onprovidererror) rather than repeated here.)

**Current leading hypothesis — labelled as a hypothesis, not a finding.** The gateway's streaming
code path appears to render an upstream rate limit as an empty `200` rather than surfacing it as an
error, while the non-streaming path on the same deployment surfaces the identical condition
honestly as a rate-limit error. Supporting evidence: an identical non-streaming request returned a
real rate-limit error with its streamed twins, seconds either side of it, returning empty `200`s
instead of an error; zero empty responses were observed across the non-streaming sample in the same
window; and an independent single-threaded control run recorded several empties inside the same
one-minute band as a production failure. The degraded window could not be toggled on and off at
will to isolate cause from coincidence, and the upstream deployment is shared with other
traffic this investigation does not control for — so treat this as the best current explanation,
not a closed root cause.

**What a proxy admin would need to answer, that a client cannot:** why the streaming path swallows
an upstream error the non-streaming path raises honestly; why no usage chunk is emitted on the
empty responses even when the request explicitly asks for one; what the upstream rate quota is on
the affected deployment and whether a fallback exists for it; and, separately, a chunk-identity
defect independent of this investigation — one streamed response was observed emitting three
different response ids across four chunks, which violates the single-id-per-response contract the
client code assumes.

**What the harness captures, so the next occurrence is actionable.** The failing call's gateway
correlation headers (`x-litellm-call-id`, `x-litellm-model-id`, `x-litellm-response-duration-ms`,
`x-litellm-version`) are captured off the response and printed in the abort — deliberately never the
key/spend headers — so a single failing call id can go straight to whoever administers the gateway,
without reconstructing it from timestamps. This was observed against a gateway pinned to
**LiteLLM 1.89.7**; version drift is worth checking early in any proxy investigation; a later,
unrelated gap in the same registry (a reasoning-effort capability flag) was found to have shipped
only in **1.93.0**, two months of releases ahead of what was running.

## Related
[`models.json`](../configuration/models.md) · [`routing.json`](../configuration/routing.md#onprovidererror) ·
[Providers and tiers](../concepts/providers-and-tiers.md)
