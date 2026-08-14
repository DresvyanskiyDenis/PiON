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

## What other modules write into it

Besides the per-session row, modules append to the event log through a single `logEvent` call —
session id, kind, name, an `ok` flag, an optional duration and an optional JSON payload. Names
follow one shape, `<domain>.<action>:<subject>`, so a whole kind reads as one stream:

| Kind | Name | Written by |
|---|---|---|
| `dispatch` | `teammate.spawn:<name>`, `teammate.send:<name>`, `teammate.close:<name>` | [teammates](teammates.md) |
| `dispatch` | `dispatch.resolve:<agent>` | [dispatch](dispatch.md) |

`dispatch.resolve` is the answer to *what model did this delegation run on, and why*: the `subagent`
tool the call arrived on, the agent, the resolved provider, and the model record — the spec's origin,
what it resolved to, its tier, and the default's scope when the tier was defaulted rather than asked
for — plus the concurrency and the isolation applied, if any. It is written **whenever a spec
resolves**, not only when the call's model was rewritten; a dispatch a rule *refused* writes no such
row, because that block is already in the guarded handler's own audit entry. Both places have to be
read to account for every delegation.

The payload column is generic JSON, so a new event kind needs no schema change and an existing
`index.db` keeps working.

## Never throws

"Observability must never break a session" holds for every call site. A failed index write is a
logged line, not an exception.

## Cost

One SQLite file under the state root, plus a small write per session event. A backfill pass exists
for sessions that predate the index.

## Related
[digest](digest.md) · [Configuration layout](../getting-started/config-layout.md#runtime-state)
