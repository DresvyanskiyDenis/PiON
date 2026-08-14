# `path-defaults` — per-directory defaults

Per-`cwd` defaults for tier, plus a declarative per-channel policy. Configured by
[`config/path-defaults.json`](../configuration/paths-and-trust.md#path-defaultsjson).

Registers `/path-defaults-status`.

## Two different things both called "egress"

This trips everyone once, so it is worth being explicit.

### 1. Session egress class — a reported label

One scalar per matched root (`public` / `internal` / `confidential`), derived from the root's
**tier**'s provider via `routing.json`'s `egress` map. It is exported into the environment, where
[`dispatch`](dispatch.md) reads it to print on the startup line, in `/agents` and in the sub-agent
model-selection block.

Until 2026-08-13 it also *decided* something: it made "a confidential root's session may not
dispatch a child onto a public provider" true. That containment rule is withdrawn — it made most
agents undispatchable rather than making anything safer — so this scalar now describes the session
and refuses nothing. See [ADR 0004](../adr/0004-egress-classes-are-declarative.md).

### 2. Per-channel policy — declarative only

`{web, mcp, publicModels}`, each `"allow"` or `"deny"`, per root. A different fact: whether this
directory's session *should* reach the open web, use MCP tools, or fall back to a public model.

!!! warning "This module does not intercept anything to enforce channel policy"
    It computes and exports the value for [`web`](web.md) and the MCP layer to read at their own
    call sites. A directory tree with no such wiring in place enforces **nothing** from this
    channel. The notice the module prints says so.

    Nobody should read the presence of a `"deny"` entry here as proof that traffic is blocked. It
    is a declaration, not a network boundary.

## Why `setModel()` at `session_start`

There is no tool call to gate — "which model does this session start on" is decided before any tool
exists. So the tier default is applied once, at session start, rather than by a `tool_call`
handler.

## Reasoning effort

A root names a tier, and a tier may declare how hard to think — `"thinkingLevel": "high"` on the
row, one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. That level is now **applied,
not merely parsed**: this module runs inside `session_start` holding the extension API, so it calls
`setThinkingLevel()` (which PI clamps to what the model actually supports) immediately after a
successful `setModel()`, and on no other path. If an explicit model selection is already in effect,
if the model is not in the registry, or if the provider has no usable credential, this module
returns before that call and the session's effort is left exactly as it was.

A `thinkingLevel` that is not one of the seven levels is a **hard error**, naming the tier, the
value and `routing.json`. Nothing is guessed, and nothing quietly falls back to the provider
default.

A tier's `model` is meant to be a bare `provider/id` with the level in `thinkingLevel` and
[nowhere else](../configuration/routing.md#how-thinkinglevel-reaches-the-child) — but if one does
carry a `:level` suffix, it is split off before the model registry is asked whether the model
exists, so `provider/some-id:high` now resolves exactly like `provider/some-id` instead of being
reported as unconfigured. Where a row states both, **the suffix wins**: it is the more specific
statement, the same precedence [`dispatch`](dispatch.md) applies to the same row. Only a *known*
level splits — a typo such as `provider/some-id:hgih` stays part of the id, misses the registry and
is refused by name, which is the loud failure rather than a quiet downgrade.

## Related
[`path-defaults.json`](../configuration/paths-and-trust.md) · [dispatch](dispatch.md) ·
[Providers and tiers](../concepts/providers-and-tiers.md#egress-classes)
