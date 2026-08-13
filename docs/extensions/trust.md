# `trust` — project trust, the MCP config gate, and the deadman

**Loads second, immediately after [`guard`](guard.md).** Three jobs that look unrelated and are
not.

## 1. Scoped project trust

PI asks whether a project directory may contribute its own extensions, hooks, skills, agents and
MCP servers. This module answers **`"yes"` only inside the roots declared in
[`config/trusted-roots.json`](../configuration/paths-and-trust.md)**, and **`"undecided"` everywhere
else** so PI's own prompt still runs.

It never answers `"no"`. That would suppress the prompt and turn a question into a silent refusal.

The alternative — `defaultProjectTrust: "always"` in `settings.json` — trusts *every* directory PI
is ever started in, including a freshly cloned third-party repository whose `.pi/extensions/` then
runs with full permissions. It was rejected on review; `config/settings.json` keeps
`"ask"`.

## 2. The MCP project-config gate

The vendored MCP adapter reads a project's `.mcp.json` / `.pi/mcp.json` **before PI's trust
decision exists**. This module installs the gate that closes that window.

!!! danger "Path trust and MCP-config trust are deliberately different questions"
    Path trust answers *may PI run here without asking?* MCP-config trust answers *may this
    directory name the processes this agent spawns with its full credential environment?*

    Wiring the first answer into the second made `git clone <hostile> && cd && pi` sufficient to
    spawn an eager stdio server holding every token in `process.env` — silently, with no `tool_call`
    for the guard to see.

The gate requires an explicit persisted approval of the project path **and** the sha256 of its MCP
config, recorded by [`pi-mcp-approve`](../configuration/mcp.md#the-project-trust-gate) in
`~/.config/pi-config/mcp-approvals.jsonl` (`0600`). It is reconciled against
`ctx.isProjectTrusted()` at `session_start`.

## 3. The deadman

A guardrail that failed to load is a fail-**open**, and a *silent* fail-open is the worst outcome
in this whole design.

At `session_start` this module reads `extensions/lib/manifest.ts`'s expected-but-absent report. If
a guardrail module is absent or failed to register, it says so on every surface available and
**blocks the dangerous tools outright** — `bash`, `write`, `edit`, `multiedit`, `read`, `grep`.

The session still starts. It just cannot do anything that matters until you fix the load error,
which is the correct trade: an agent that refuses to work is a bug report, an agent that works
without its guardrails is an incident.

!!! note "Why it does not gate on a `guard:ready` event"
    PI's event bus is a bare `EventEmitter` with **no replay buffer**. `guard` emits its handshake
    synchronously inside its own `register()`, so any listener attached afterwards receives nothing,
    ever. The deadman gates on the manifest load record instead — a mechanism with no ordering
    dependency. The same reasoning shapes [`doctor`](doctor.md)'s `D-06`.

## Related
[`trusted-roots.json`](../configuration/paths-and-trust.md) · [`mcp.json`](../configuration/mcp.md) ·
[Safety model](../concepts/safety-model.md)
