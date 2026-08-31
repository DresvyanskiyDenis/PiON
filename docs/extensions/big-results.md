# `big-results` — a handle instead of a truncation

Registers the `expand_result` tool.

PI already truncates built-in tool output at 2000 lines / 50 KB and, for `bash`, points at the
overflow file it wrote. This module does two things that covers:

1. **Extends the same 50 KB boundary to every tool result** — custom tools, MCP tool results,
   sub-agent returns — which PI's own truncation does not cover.
2. **Hands back a re-expand handle** instead of a one-shot head/tail summary, so the full text can
   be read back later without re-running the tool.

The threshold deliberately matches PI's built-in boundary rather than inventing a new one, so there
is one number to reason about rather than two.

## Two channels, not one

A tool result is not the only way unbounded third-party text reaches a provider request. An
extension that calls `pi.sendMessage()` writes a `custom_message` entry, which PI renders into a
plain user message carrying the whole content and re-sends on **every subsequent request of the
session** — the [web](web.md) package does exactly that for its search-curator follow-up, so one
large fetch becomes a permanent per-request cost. That text never passes through `tool_result`.

So the boundary is enforced on both channels: `tool_result`, and a `context` handler that spills an
oversized `role: "custom"` wire message through the same code path — same `results/` layout, same
sidecar, same card, same `expand_result` handle. Only the **wire copy** is shrunk; the session file
keeps the full text, so the transcript stays a complete record and a package's own "read that fetch
back by id" tool still works.

The patch is prompt-cache safe by construction: the handle is a hash of the text and the patch is
memoised per session, so firing once per request produces byte-identical messages and the
provider's cached prefix survives. A patch that varied per call would invalidate the whole
conversation behind it once per request — the exact cost this module exists to avoid.

**Not covered, on purpose:** the `type: "custom"` session entries written by `pi.appendEntry()`.
They do not participate in LLM context at all — they cost session-file bytes and no tokens — and no
extension hook fires between that call and the entry, so there is nothing to bound.

## Why a handle and not a shrink

An adopted context-shrinking package was considered for this and rejected for the purpose:
**shrinking is lossy and irreversible; a handle is neither.**

The failure a handle avoids is specific. A model that receives a truncated result and needs the
missing part has one option: run the command again. If the command was expensive, slow, or had side
effects, that is the wrong option — and it is the option the model will take, because the alternative
is guessing.

## Shape

The model sees a head, a tail, the size, and a handle. `expand_result` takes the handle and returns
the full content from the session scratchpad.

## Related
[bash](bash.md) · [`bash-timeouts.json`](../configuration/tools.md#bash-timeoutsjson) · [jobs](jobs.md)
