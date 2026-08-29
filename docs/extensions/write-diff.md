# `write-diff` — an overwrite you can read

One job: when `write` lands on a file that already existed, append a diff of what changed. A `write`
that *creates* a file gets no card at all.

## Why `write` and not `edit`

The obvious place to want a unified diff is `edit`, and PI already puts one there.
`core/tools/edit.js:116` passes `result.details.diff` through `renderDiff` for the result, and
`:139` does the same for the live preview; `renderDiff` itself
(`modes/interactive/components/diff.js:70`) groups runs of `-` and `+` lines, colours them through
`toolDiffRemoved` / `toolDiffAdded` / `toolDiffContext`, and highlights the changed span inside a
line. Nothing an extension could add there would be an improvement, and replacing it would be a
downgrade. This module does not touch `edit`, and a test asserts that it does not.

`write` is the tool that dumps. `formatWriteResult` (`core/tools/write.js:118`) returns the error
string and nothing else, and the call component prints the first ten lines of the **new** content
(`core/tools/write.js:101-114`). For a file being created that is exactly right — all of it is new,
so a preview of the top is what a reader wants. For a `write` that landed on a file which already
existed it is the wrong display: there, *what changed* is the only interesting question, and the
answer is a syntax-highlighted copy of the result with the answer nowhere in it.

## Where the pre-image comes from

Nothing in a `write` result carries the old bytes. `core/tools/write.js:161` returns
`details: undefined`, and by the time `tool_result` fires the file on disk already holds the new
content. `tool_call` is therefore the last moment at which the old file still exists, and that is
where the pre-image is read and held until the result lands.

Deliberately **not** `tool_execution_start`. That event is emitted from the agent's event stream
(`core/agent-session.js:500`) with no ordering guarantee against the execution it announces, so a
pre-image read from it can arrive one moment too late. The failure mode is silent — an empty diff
that confidently claims nothing changed — which is why the ordering is a test rather than a
comment.

## What it costs, and the caps on it

One `stat` per `write`, plus one read of files below the cap, on the same path the gates already
run on.

| Constant | Value | What it stops |
|---|---|---|
| `MAX_PREIMAGE_BYTES` | 512 KiB | Paying to read back a very large file for a card nobody will read row by row |
| `MAX_PENDING` | 32 | The pre-image map growing when a call is blocked by a gate or abandoned mid-turn and no `tool_result` ever arrives to clear its entry |
| `MAX_DIFF_LINES` | 200 | A whole-file rewrite becoming a 4000-row transcript entry |
| `COLLAPSED_DIFF_LINES` | 10 | The collapsed card outgrowing PI's own ten-line write preview |

A capped diff says so: the card's last row names how many rows were dropped, so a truncated diff is
never mistaken for a complete one.

## Posture

Presentation, and nothing else. Every handler returns `undefined` and swallows its own failures — a
pre-image that could not be read becomes one line on stderr and no card. A diff card must never be
the reason a write does not happen.

The renderer goes through [`safeEntryRenderer`](../extending/index.md), so a malformed entry
renders as PI's generic fallback rather than as an error box repainted on every redraw.

## Configuration

None. There is no settings key, no threshold to tune, and nothing to enable — the module is on when
it is loaded and silent when there is nothing to show.

## Related

- [big-results](big-results.md) — the other module that decides how much of a tool result belongs in
  the transcript.
