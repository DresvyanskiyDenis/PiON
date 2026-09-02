# ADR 0008: A peer's request to compact travels on a control lane, not as a chat message

- **Status:** Accepted
- **Date:** 2026-09-02

## Context

`message_agent` (EXT-32) already lets one live session hand another a message: `deliver()` stages an
envelope in the recipient's inbox, `drain()` picks it up at `session_start`/`turn_end`/its own poll,
and hands it to `pi.sendMessage()` — which means every envelope, without exception, becomes a turn the
recipient has to read and reason about. That is the right shape for "tell session B something" and
the wrong shape for "make session B compact its own context right now": a request to reclaim context
is not content for the recipient to interpret, it is an instruction for the harness to act on, and
routing it through the chat turn would burn exactly the context budget the request exists to save.

A second, unrelated gap sits next to this one. Nothing in this tree ever tells an *external* observer
how full a live session's context window is. `extensions/compaction/gauge.ts` computes and displays
`percent` in the TUI, but that number lives and dies inside the session's own process — there is no
way for a cron job, a supervisor, or a peer session to ask "is anyone close to running out of room?"
without teaching every future consumer of that answer to reopen the same computation, and there was no
answer at all for "did this session recently compact?" A watchdog that wants to nudge sessions over a
threshold needs both a live percentage and a way to avoid re-nudging a session that already dealt with
it, from *outside* that session's own process.

REQ-PRV-91 (the audit log carries counts and identifiers, never message content) already governs what
`session-index` is allowed to record. Any live-usage signal a watchdog reads has to satisfy the same
constraint: a percentage and a token count are fine to log; nothing about *why* the context filled up
is.

## Decision

**A `kind` field on the existing message envelope splits it into a control lane and the ordinary chat
lane, and `"compact"` is the first control kind to use it.** `drain()` routes every envelope whose
`kind` is absent or `"message"` exactly as it already did (`pi.sendMessage()`, a chat turn). Every
other `kind` goes to a handler registered through `registerControlHandler(kind, handler)`
(`extensions/message-agent/control.ts`) instead — it never reaches `pi.sendMessage()`, so it costs the
recipient's context nothing until the handler actually decides to act. `extensions/compaction/peer.ts`
registers the `"compact"` handler: it runs the session's own `ctx.compact()`, merges the sender's
`instructions` as the customary compaction instructions, and replies to the sender (through the same
`message_agent` directory, as an ordinary chat message) with `ok`, `deferred`, or `refused` and — on
success — the reclaimed token estimate.

Mechanism:

- **Schema is a floor, not an equality check.** `Envelope.schema` moves from 1 to 2 to carry `kind`
  and `instructions`, but `drainInbox()` accepts any `schema >= AGENT_SCHEMA` rather than requiring an
  exact match, and an envelope whose `kind` has no registered handler is announced once (`report()`,
  the existing once-per-key notice mechanism) and cleared — never left stuck, never silently retried
  forever, and never turned into a chat message the recipient has to notice on its own. A drain-side
  reader from a version that predates `kind` still accepts schema-2 envelopes; a reader from a version
  that predates a future `kind` still degrades to "unhandled, cleared" instead of crashing. This is the
  same forward-compatibility posture the directory already applies to unknown fields elsewhere in this
  tree — tolerate what you don't recognize rather than reject it.
- **Defer, don't drop, mid-run.** A control handler that decides now is the wrong time to act (the
  peer-compact handler's own rule: never mid-turn, since `ctx.compact()` while a turn is in flight
  would compact out the very turn using it) returns `{outcome: "deferred"}`, and the dispatcher
  (`recoverStaged`, `extensions/message-agent/directory.ts`) puts that one envelope back in the inbox
  rather than deleting it. The next `drain()` — the very next `turn_end`, no special retry timer needed
  — sees it again and gets another chance to accept it once the session is idle. A dropped request
  would silently fail the sender's expectation that asking for a compact does something; deferring
  costs nothing but one more drain cycle, which the session was going to run anyway.
- **A wall-clock rate limit, not a request-count one.** `peer.ts` tracks `lastPeerCompactAt` per
  session and refuses (`{outcome: "refused"}`, with a reply naming the wait) a second peer-triggered
  compact within `compaction.peerCompact.minIntervalMs` (`config/compaction.json`, default five
  minutes) of the last one it actually ran for that session. This is deliberately a per-session
  timestamp, not a per-sender or per-envelope count: the failure this guards against is a session being
  asked to compact repeatedly by one or many peers faster than compaction can plausibly help, not a
  single noisy sender. `session_shutdown` clears the timestamp for that session id, so a fresh session
  under a reused id (the recovery path EXT-32 already exercises) does not inherit a rate limit that
  belongs to a run that already ended.
- **The watchdog's live-percentage source is the session-index events table, not a new channel.**
  `refreshGaugeStatus()` (`extensions/compaction/index.ts`) already runs on `session_start` and
  `turn_end`; it now also logs a `{kind: "context", name: "usage", payload: {percent, tokens,
  contextWindow}}` event through `logEvent`, and `session_compact` logs a `{kind: "compaction", name:
  "compacted"}` marker with an empty payload. `bin/pi-compact-watchdog` (REQ-CTX-35) reads only these
  two event streams — the most recent `usage` row and the most recent `compacted` row — per live agent
  (`listAgents`, the same directory `message_agent` already maintains), and hands them to
  `extensions/compaction/watchdog.ts`'s pure `shouldTriggerCompact(signal, now, threshold, cooldown)`.
  Choosing the audit trail that already exists over a new IPC surface means the watchdog reads exactly
  what REQ-PRV-91 already permits to be written — a count and a timestamp — and needs no new capability
  granted to it beyond read access to a database every other tool in this tree already reads.
  `shouldTriggerCompact` refuses to fire on `percent === null` (an unknown quantity is not evidence of
  being over threshold — the same "don't guess" posture REQ-PRV-91 imposes on the write side), on a
  sample whose `lastCompactedAt` is at or after it (already handled), and on a signal older than its
  own cooldown window (the session may have gone idle or exited; a watchdog is meant to be silent about
  it, not send a compact request into a mailbox nobody is reading).
- **The watchdog is cron material, not a daemon this tree starts.** It is silent on the common case
  (nothing printed when nothing is over threshold) and writes exactly one `"compact"` control envelope
  per over-threshold session per run, addressed the same way any peer would address one — through
  `deliver()`, not a private code path. An operator decides the schedule; nothing in `register()` spawns
  it automatically.

## Consequences

**Positive**

- A peer-triggered compact costs the recipient's context nothing beyond the compact itself: the
  request is handled and answered without ever occupying a turn the recipient has to read.
- `kind` is additive and tolerant in both directions: an old envelope with no `kind` is still exactly
  an ordinary message, and an envelope with an unrecognized `kind` degrades to "announced once,
  cleared" rather than corrupting the inbox or blocking every envelope behind it.
- The rate limit and the defer-not-drop guard both fail toward the sender finding out what happened
  (a reply naming the reason) rather than toward a request that silently vanishes.
- The watchdog adds no new write surface to the audit log beyond two event kinds already shaped like
  everything else `logEvent` records, so REQ-PRV-91 does not need a new carve-out to accommodate it.

**Negative**

- The per-session rate limit lives in the peer-compact handler's own in-memory map, not in
  `config/compaction.json`'s persisted state — a session restart resets it. This is deliberate (a
  restarted session has, definitionally, not compacted recently in its own lifetime) but means the
  limit does not survive a crash-and-recover cycle the way the inbox's own staged envelopes do.
- The watchdog's view of "live" is only as fresh as the last `usage` event a session happened to log;
  a session that has gone well past `DEFAULT_WATCHDOG_COOLDOWN_MS` since its last turn without
  shutting down cleanly (a stalled or wedged session) will stop being nudged, indistinguishable from one
  that exited normally.

**Neutral, noted but not built**

- `kind` is a flat string, not a versioned union — adding a second control kind means adding a second
  `registerControlHandler` call, not touching the envelope shape again. This decision does not attempt
  to anticipate what that second kind will need.
- The watchdog never reads `instructions` back out of a `"compact"` envelope it did not itself send; it
  only ever writes one. Nothing in this decision gives a watchdog visibility into what a peer's own
  `"compact"` request asked for.

## Alternatives considered

| Option | Why not |
|---|---|
| Send `"compact"` as an ordinary chat message and rely on the recipient's own reasoning to notice and call `ctx.compact()` itself | Costs the recipient exactly the context a compact request exists to reclaim just to notice the request, and depends on a model choosing to act rather than a deterministic handler doing so. |
| Add a second envelope directory (`.control/`) parallel to the inbox, rather than a `kind` field on the same envelope | Doubles the staging/draining/recovery machinery EXT-32 already has for one field's worth of new behavior, and reintroduces exactly the kind of divergent-path bug class `directory.ts`'s single inbox was written to avoid. |
| Drop a control envelope with no registered handler, the same as any other malformed input `drainInbox()` already rejects | An unrecognized `kind` is not malformed — it is a legitimate message from a newer or differently-configured peer. Dropping it silently is indistinguishable, from the sender's side, from the message never arriving; announcing once and clearing at least surfaces the gap to whoever is watching that session's notices. |
| Let a mid-run `"compact"` request queue until `ctx.isIdle()` becomes true, rather than putting it back in the inbox for the next drain to reconsider | `recoverStaged` reuses the exact recovery path EXT-32 already has for a session that dies mid-delivery — no second queue, no second data structure to keep consistent with the inbox's own crash-recovery guarantees. |
| Poll every session's live process for its context percentage, rather than reading events already logged to the session index | Requires a new IPC channel into every live session's process just to expose one number that `refreshGaugeStatus()` already computes and displays; the events table already exists, is already read by other tooling in this tree, and already satisfies REQ-PRV-91. |
| A persisted (config-file or on-disk) rate-limit timestamp, surviving process restart | The failure this guards against — a session compacting for peers faster than compaction can help — resets exactly when the session itself resets; persisting it across a restart would rate-limit a session against work a *previous* process did, which is not the risk being managed. |

## Reopen this if

- A second control `kind` needs a reply channel other than an ordinary chat message back through
  `message_agent` — the current design assumes every control handler's response is itself worth a
  peer reading, which may not hold for a kind whose answer is large or structured.
- The watchdog's cooldown-based staleness check (`DEFAULT_WATCHDOG_COOLDOWN_MS`) proves too blunt for
  distinguishing "exited cleanly" from "wedged" — that would be evidence for `listAgents`' own liveness
  sweep to feed the watchdog directly, rather than inferring liveness from event recency alone.
- `peerCompact.minIntervalMs`'s in-memory, per-process rate limit is observed missing repeated
  peer-compact storms that span a session restart — that would be evidence for moving the timestamp
  into persisted state after all, despite the reasoning above.

## Related

- [ADR 0001](0001-no-provider-failover.md) — a different lane, same instinct: keep a mechanical
  decision (route a request, don't ask the model to notice and act) out of the chat turn's own
  reasoning path.
