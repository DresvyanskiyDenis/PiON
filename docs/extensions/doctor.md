# `doctor` — `/doctor` and the session-start warn pass

**Composes last**, so its report observes every module above it.

Registers `/doctor`. A cheap subset also runs automatically at every `session_start` — everything
except `D-04`, which needs the model registry and is therefore network-shaped.

## The nine checks

| Check | Asks |
|---|---|
| `D-01` | every tool name your instruction text mentions actually exists (or is declared in `config/tools.declared.json`) |
| `D-02` | every skill name mentioned has a `SKILL.md` PI actually discovered |
| `D-03` | every agent name mentioned has a file in `agents/` |
| `D-04` | every tier in `routing.json` resolves to a model in the registry, **and** that model has a credential |
| `D-05` | every declared extension module loaded — a module that threw, *and* a module that never attempted registration, are **both** errors |
| `D-06` | the guard loaded **and** its synthetic probe `matchDangerous("rm -rf /")` still resolves to `DB-RM-ROOT` |
| `D-07` | every MCP server name mentioned is declared in `config/mcp.json` |
| `D-08` | every pinned package in `config/packages.lock.json` is installed at that version (**warn**, not error) |
| `D-09` | the hook layer is carrying rules rather than sitting degraded |

**`D-06` is the only finding that shuts the session down.** Everything else reports and continues.

## Declared, not merely enabled

Every skill, agent, tool and MCP server named in the assembled instruction text resolves against
**declared** resources, not against what happens to be enabled right now. A skill scoped out of this
session's `cwd`, or a package tool whose provider lacks a credential today, must not read as drift —
otherwise the report cries wolf and stops being read.

`config/tools.declared.json` is the allowlist for tools in that position. See
[Generated and locked files](../configuration/not-editable.md).

## `D-05` reports two different failures with one severity

A module missing from the registry **with a failure entry** threw during `register()`. A module
missing **with no entry beside it** was never even tried — its import failed, and static ESM imports
resolve before any module body runs, so nothing was alive to record it.

Both are errors because the severity is the same. They are reported distinctly because the fix
differs: read the stack trace, versus check the import graph.

## Why `D-06` does not gate on an event

`guard` emits its readiness handshake **synchronously inside its own `register()`**, and PI's event
bus is a bare `EventEmitter` with **no replay buffer** — a listener attached afterwards receives
nothing, ever, for that emission. Since `doctor` composes last, subscribing here could never observe
it.

So `D-06` gates on the manifest load record plus a **direct, synchronous** call to
`matchDangerous("rm -rf /")`, which needs no event at all. Verified by reading the event bus source
rather than assumed from its type declarations.

The subscription is kept anyway — cheap, harmless, and it starts working the moment the composition
order changes. Its payload is surfaced as an enrichment, **never** as the pass/fail signal.

## Related
[First run](../getting-started/first-run.md) · [guard](guard.md) · [trust](trust.md) ·
[Verification](../operations/verification.md)
