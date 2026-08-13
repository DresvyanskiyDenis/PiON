# `session-index` — local observability

Registers `/index`. Maintains a local SQLite index of sessions: identifiers, counts, durations, git
facts, token usage.

## Read-only by construction

Every write goes to `index.db`. Every read of a **session file** goes through a `readFileSync`-only
contract. **No code path here can open a session file for writing.**

That is a structural guarantee rather than a careful one. An observability module that can corrupt
the thing it observes is not worth having.

## What is stored

Identifiers, counts and durations only — **never message content**. That is a calling convention the
insert function cannot enforce, only document, which is why it is stated in the code and again here.

## Never throws

"Observability must never break a session" holds for every call site. A failed index write is a
logged line, not an exception.

## Cost

One SQLite file under the state root, plus a small write per session event. A backfill pass exists
for sessions that predate the index.

## Related
[digest](digest.md) · [Configuration layout](../getting-started/config-layout.md#runtime-state)
