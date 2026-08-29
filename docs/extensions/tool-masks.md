# `tool-masks` — taking the tool away instead of refusing the call

Three commands that change the tool list the model sees, mid-session: `/review`, `/explore`,
`/ship`.

## Why a mask and not a rule

[`guard`](guard.md) is an audit layer. `FS-*`, `PRV-*` and `SEC-*` observe a call the model has
already spent tokens choosing, and answer it with a denial the model can read, argue with, and
route around. A mask removes the choice one step earlier: under `/review` there is no `write` in
the tool list at all, so there is nothing to deny, no escape hatch to write, and no prompt text to
ignore.

The two are not alternatives. The guard still governs the unmasked session, which is most of them.

## The three commands

| Command | What is left active |
|---|---|
| `/review` | `read`, `grep`, `find`, `ls`, `expand_result`, `ask_user` |
| `/explore` | the same, plus `web_search`, `web_fetch`, `web_answer` |
| `/ship` | exactly what was active before the first mask |

The statusline shows which one is on: `tools full`, `tools review`, or `tools review (auto)` when a
path rule asked rather than you.

## An allow-list, and why

Each mask names what **survives**, never what is dropped. The tool registry is open: this tree
registers tools of its own, an MCP server contributes proxy tools by name, and an adopted package
can add more next month. Under a deny-list, a tool nobody had classified would stay active, which
is the one failure mode a mask exists to prevent. Anything unrecognised is masked out instead.

A mask is the intersection of its allow-list with what was **already** active, so it can only ever
narrow. Asking for a mask never grants a tool the session did not have.

!!! note "`bash` is gone under every mask, not narrowed"
    `setActiveTools` works at the granularity of a whole tool, and there is no read-only `bash` to
    substitute. "Drop mutating `bash`" is therefore expressed the only way the primitive allows:
    under a mask, `bash` is not in the list. That is stricter than the wording and matches its
    intent, that the model physically cannot change the tree.

## `/ship` restores a capture, not a constant

`setActiveTools` has no inverse. PI can enumerate everything *configured* (`getAllTools()`), but
that is not what this session had active: `settings.json`, another module, or you may have narrowed
it long before a mask existed. So the tool list is captured once, on the way out of the unmasked
state, and `/ship` restores that capture. A tool that appeared **while** the mask was on (an MCP
server that connected mid-session) is added back on top rather than dropped.

## Surviving `/compact`, fork and resume

Module state dies with the extension runtime, and a fork, a session switch or a reload stands up a
new one. So every operator transition is also appended to the session as a `tool-masks.state` custom
entry, and `session_start` and `session_compact` replay the last one. The baseline travels inside
the entry, which is what lets a resumed session `/ship` back to the list its ancestor had.

This is [`subagent-cost`](subagent-cost.md)'s "seed from the session file" idiom, applied to a
capability instead of a number. The entry is a custom entry, never LLM context.

## Composing with `path-rules`

A rule in `rules/*.md` may answer with a mask instead of with text:

```markdown
---
paths:
  - "**/*.env"
  - "**/secrets/**"
mask: review
---
Touching a secret file drops the write side of the tool list for the rest of this turn.
```

Touching a matching file narrows the surface for the rest of the turn; the rule's body is never
injected, because the point of a mask is that the capability is gone rather than argued about in
prose. `mask:` requires `paths:` (a mask is a response to a touch), and a value that names no real
mask drops that one rule with a warning at load time rather than failing silently.

An automatic mask may **tighten** an operator's mask, never loosen it. `turn_end` releases it, and
it falls back to the operator's own mask rather than to the full set. It is never persisted: only
`/ship` clears what you asked for.

Such a rule is also skipped by [`path-rules`](path-rules.md)' startup scan, and stays out of the
`durable` set. The scan answers "does this project contain such a file"; a mask has to answer "is
the model touching one right now", and has to fire again next turn.

## Posture

`tool-masks` is composed **before** `path-rules`, because a `mask:` rule calls into it. Every
lifecycle handler is guarded: a bug in a mask must never take down the event it rode in on. The
statusline half goes through `ctx.ui.setStatus` and a `config/pi-statusline.json`
`extensionStatusIcons` entry, the same supported seam [`quota`](quota.md) and
[`subagent-cost`](subagent-cost.md) use.
