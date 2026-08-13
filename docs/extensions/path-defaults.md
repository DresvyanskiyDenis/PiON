# `path-defaults` — per-directory defaults

Per-`cwd` defaults for tier, plus a declarative per-channel policy. Configured by
[`config/path-defaults.json`](../configuration/paths-and-trust.md#path-defaultsjson).

Registers `/path-defaults-status`.

## Two different things both called "egress"

This trips everyone once, so it is worth being explicit.

### 1. Session egress class — enforced

One scalar per matched root (`public` / `internal` / `confidential`), derived from the root's
**tier**'s provider via `routing.json`'s `egress` map. It is exported into the environment where
[`dispatch`](dispatch.md) and the guard's `RTE-*` routing gate read it, and it is what makes
"a confidential root's session may not dispatch a child onto a public provider" true.

This is a real, already-shipped enforcement path. It refuses a **dispatch**.

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

## Related
[`path-defaults.json`](../configuration/paths-and-trust.md) · [dispatch](dispatch.md) ·
[Providers and tiers](../concepts/providers-and-tiers.md#egress-classes)
