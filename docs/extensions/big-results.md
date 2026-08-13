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
