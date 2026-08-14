# PiON

**PiON — a hardened, portable harness for the [PI coding agent](https://github.com/earendil-works/pi).**

PI ships a good agent loop, a tool set, a TUI and a provider layer. It does not ship a permission
system, a way to say "run this sub-agent on the cheap model", a compaction loop guard, a background
job directory that survives the process, or a headless wrapper that actually exits non-zero when a
turn fails. This repository is the layer that adds those, as one composed extension plus a
configuration tree that is symlinked into `~/.pi/agent/`.

It is built and measured against **PI 0.84.0 on macOS (arm64), Node ≥ 22.19.0**. Most of it is
platform-neutral TypeScript; the install script and a handful of shell helpers assume a POSIX
shell and are exercised on macOS.

---

## What you get

<div class="grid cards" markdown>

- **Multi-provider routing by semantic tier**

    Agents, scripts and cron jobs name a *tier* — `strong`, `fast`, `cheap`, `confidential`,
    `local` — never a model id. Repointing a tier is a one-line edit in
    [`config/routing.json`](configuration/routing.md).
    → [Providers and tiers](concepts/providers-and-tiers.md)

- **Fail loud, no failover**

    A provider error aborts the turn naming the provider, the model, the error class, the message
    and the cause chain. Nothing is silently retried onto a different provider or a cheaper model.
    → [`onProviderError`](concepts/providers-and-tiers.md#fail-loud-no-failover)

- **A permission layer PI does not have**

    Six ordered gates over every tool call: secret paths, catastrophic bash and destructive git
    block outright; privileged commands, the write surface and agent routing are recorded, not
    refused.
    → [Safety model](concepts/safety-model.md) · [`guard`](extensions/guard.md)

- **MCP behind a default-deny trust gate**

    A project's `.mcp.json` is not read until that exact file has been approved by digest, and a
    project-sourced stdio server is spawned from an empty environment plus an allowlist rather
    than inheriting every API key you have exported.
    → [MCP servers](extending/mcp-servers.md)

- **Sub-agents, teammates, jobs and worktrees**

    Depth-limited dispatch with per-provider concurrency, a cross-session background job directory,
    and `isolation: worktree` that never nests and never `rm -rf`s a dirty tree. Long-lived named
    teammates carry a delivery obligation welded into the spawn path, but `spawn` refuses out of the
    box until the host supplies a model-resolving spawner — see
    [Teammates](extensions/teammates.md).
    → [Orchestration](extensions/dispatch.md)

- **Honest context accounting**

    A `/context` command that separates the preamble from the compactable dialogue, a compaction
    loop guard, and the single most valuable operational rule in the project:
    `contextWindow = min(200000, what the endpoint actually serves)`.
    → [Context windows](concepts/context-windows.md)

</div>

Plus: declarative YAML hooks, task-list nudges, session digests, a session index, a Copilot quota
meter, `@import` expansion in instruction files, oversized tool-result externalisation with a
re-expand handle, automatic session titling, and a `/doctor` command that reports which modules
loaded and which are expected-but-absent.

---

## What it does *not* ship

**No skills and no MCP server definitions.** Both were the original operator's personal setup and
were removed before this repository was made public. What remains — and what is genuinely the
valuable part — is the *machinery*: skill discovery across extra roots, the `PI_SKILL_DIR_*`
environment shim, the `allowed-tools` portability lint, the vendored MCP adapter, the
`mcp-stdio-guard` environment-minimising wrapper, and the project trust gate.

Adding your own is a first-class, documented path:

- [Adding a skill](extending/skills.md)
- [Adding an MCP server](extending/mcp-servers.md)
- [Adding a sub-agent](extending/subagents.md)
- [Adding a provider](extending/providers.md)

**No provider failover.** Deliberately. See [fail loud](concepts/providers-and-tiers.md#fail-loud-no-failover).

**No claim that the egress classes are a network boundary.** They are a declarative control that
refuses a dispatch at load time. Nothing here intercepts a socket.

---

## Where to start

| You want to… | Go to |
|---|---|
| Get it running in ten minutes | [Getting started](getting-started/index.md) |
| Understand how it is put together | [Architecture](concepts/architecture.md) |
| Know what each module does and costs | [Extensions reference](extensions/index.md) |
| Wire in your own skills / MCP servers / agents | [Extending](extending/index.md) |
| Understand the safety posture before trusting it | [Safety model](concepts/safety-model.md) |
| Know what is broken or missing | [Known limitations](limitations.md) |

---

## This site, and the wiki

Two places, on purpose, because they have different edit costs.

| | This MkDocs site (`docs/`) | The [GitHub wiki](https://github.com/DresvyanskiyDenis/PiON/wiki) (`wiki/`) |
|---|---|---|
| **Holds** | Structured reference: architecture, per-extension pages, configuration keys, the safety model | Fast operational material: FAQ, recipes, troubleshooting, a provider cheat sheet, release notes |
| **Changes** | With the code, in the same pull request | Whenever someone learns something, without a pull request |
| **Reviewed** | Yes — a broken link fails CI | No |
| **Lives in** | This repository, `docs/` | A *separate* git repository, `PiON.wiki.git` |

The wiki source is kept in `wiki/` in this repository so it is reviewable and diffable, and pushed
to the wiki remote separately. See `wiki/Publishing-This-Wiki.md`.
