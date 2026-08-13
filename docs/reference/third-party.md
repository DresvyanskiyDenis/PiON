# Third-party components

This repository is a configuration and extension layer. Most of what it does rests on other
people's work, and this page is the attribution.

Two categories, and the distinction matters legally as well as practically:

1. **Vendored source** — third-party code **committed into this repository**. Its licence travels
   with this repository's distribution.
2. **Declared dependencies** — packages installed from the registry. Not redistributed here; pinned
   by version and tarball sha256 in `config/packages.lock.json`.

---

## The platform

| | |
|---|---|
| **PI** (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`) | 0.84.0 |
| Author | Mario Zechner |
| Licence | MIT |
| Upstream | <https://github.com/earendil-works/pi> |

This repository is not affiliated with PI. It is configuration for it, pinned to one version because
several of its load-bearing behaviours are undocumented and were established by reading the shipped
code — see [Known limitations](../limitations.md).

---

## Vendored source

### `pi-mcp-adapter` 2.20.1

| | |
|---|---|
| Location in this repository | `pi-packages/pi-mcp-adapter/` |
| Author | Nico Bailon |
| Licence | **MIT** — the upstream `LICENSE` file is present in that directory and must stay there |
| Upstream | <https://github.com/nicobailon/pi-mcp-adapter> |
| Tarball sha256 | `cc35b8d045bb12f8989b8bdfe71dd3b49756c41e0c4a0fe48919ee24c4c16a7f` |
| Reviewed | 2026-08-06, verdict *adopt + harden* |

It carries its own third-party dependencies, which remain under their own licences: the Model
Context Protocol client and core packages, `ajv`, `ajv-formats`, `cross-spawn`, `open`, `recheck`,
`smol-toml` (BSD-3-Clause), `strip-json-comments`, `zod`, and an optional native keyring binding.

#### Why it is vendored

It spawns child processes and carries credentials — OAuth tokens and API-key headers — for the
servers it connects to. That alone justified pinning the exact reviewed bytes.

The decisive reason is that it is **locally patched**, and the patch changes upstream default
behaviour. Vendoring makes that patch visible in a diff and re-applicable on every version bump,
rather than a `postinstall` script silently rewriting somebody else's package. See
[Safety model](../concepts/safety-model.md#why-some-code-is-in-tree).

`pi-packages/vendor.lock.json` records the patches, and each entry marks re-application as
**mandatory on every version bump**, with the test that fails immediately if the patch was lost.

#### The patches, and how behaviour differs from upstream

**1 — Project-config trust gate** (`config.ts`)

One added block above `getConfigSources()` exporting a gate interface, plus three one-line hunks
inside `getConfigSources()`. No upstream line was deleted or reordered.

- *Upstream behaviour:* a project's `.mcp.json` / `.pi/mcp.json` is read **unconditionally** at
  session start.
- *Patched behaviour:* with no gate installed, the two **project** sources are **dropped**. Global
  sources are untouched.
- *Why default-deny rather than default-allow:* PI resolves `settings.packages` **before**
  `settings.extensions`, so the adapter runs before this repository's `trust` module can install the
  real gate. Default-allow would leave that window open.

*Why it cannot be done above the vendor boundary:* no adapter setting, environment variable or PI
hook reaches this read. The adapter's own path override swaps only the **global** source. A
`tool_call` gate is too late — servers with an eager or keep-alive lifecycle are spawned during
initialisation, before any tool call exists. `getConfigSources()` is the single funnel every read
goes through, so the gate belongs there.

*Upstreamable?* In principle yes — a `settings.projectConfigTrust` knob would serve the same purpose.
Not filed; the vendored copy is the shipping artefact.

**2 — The approval record is the gate** (`config.ts`)

Two additions inside the same patched region: the denial reason now reads *"this project's MCP config
carries no matching approval record"*, and a new exported helper enumerates the server names each
project-scoped source contributes.

- *Behavioural difference from upstream:* none **inside** the adapter — the gate contract is
  unchanged. What changed is the policy this repository installs. Approval is a persisted,
  per-project, per-sha256 ledger. Unknown project → deny. Config changed since approval → deny. No
  project MCP file at all → allow.
- There is deliberately **no first-sight auto-approval and no prompt**: eager servers spawn during
  initialisation, so a prompt would be answered by the attacker's process already starting. Refusal
  is loud and names the project, the digest, the per-file hashes and the approval command.

This replaced an earlier predicate that used **path containment** — being inside a trusted root. A
security review found that wrong: cloning a hostile repository into a trusted root was then
sufficient to admit its MCP config. See
[Safety model](../concepts/safety-model.md#mcp).

*Why not above the boundary:* the same funnel argument, plus the fact that the config reader and the
source-scope tags are module-private. Re-implementing either outside the package would be a second,
drifting copy of the discovery order.

**3 — Project stdio spawns are wrapped** (`stdio-guard.ts`, new; three hunks in `server-manager.ts`)

- *Upstream behaviour:* the adapter's environment resolution copies **all of `process.env`** into
  every stdio child, which defeats the MCP SDK's own safe default.
- *Patched behaviour:* a stdio server named by a **project** source is re-pointed at
  `config/bin/mcp-stdio-guard` with its original command as `argv[1]`, **whether or not its entry
  asked for it**, and its `MCP_STDIO_EXTRA_ENV` is dropped with a warning — otherwise a hostile entry
  could name your credentials there and walk them back through the wrapper.
- **Global / user-level servers are untouched.** They are your own config, they already opt in where
  needed, and forcing the wrapper on a server that legitimately needs an inherited environment would
  break it silently.
- If the wrapper file is missing, a project-sourced spawn **throws**. An unwrapped spawn is not an
  acceptable fallback. A command that already resolves to the wrapper is not wrapped twice.

*Why not above the boundary:* the connection factory builds the stdio transport directly. There is no
hook, no environment allowlist setting and no spawn interceptor — and only the adapter knows which
servers came from a project source.

*Why the logic is in its own file:* the manager module uses TypeScript constructor parameter
properties, which Node's strip-only loader rejects, so it cannot be imported from a test. **An
untested security control is not one.**

*Upstreamable?* Yes — a per-server `env: { inherit: false | string[] }` setting, or simply honouring
the SDK's default environment, would remove the need.

---

## Declared dependencies

Pinned by version **and** tarball sha256 in `config/packages.lock.json`; `bin/pi-check`'s `PC-09`,
`PC-18` and `PC-19` assert three-way agreement between `package.json`, that lock file and what is
installed.

### Adopted and actively used

| Package | Version | Licence | Author / org | Role here |
|---|---|---|---|---|
| `pi-subagents` | 0.41.0 | MIT | Nico Bailon | the sub-agent runtime under [dispatch](../extensions/dispatch.md) |
| `pi-web-access` | 0.18.0 | MIT | Nico Bailon | `web_search` / `web_fetch` under [web](../extensions/web.md) |
| `@juicesharp/rpiv-todo` | 2.4.0 | MIT | juicesharp | the task list under [tasks](../extensions/tasks.md) |
| `@mrclrchtr/supi-bash-timeout` | 4.6.0 | MIT | mrclrchtr | default bash timeout, under [bash](../extensions/bash.md) |
| `@narumitw/pi-worktree` | 0.49.3 | MIT | narumiruna | `/worktree`, under [worktree](../extensions/worktree.md) |
| `@narumitw/pi-statusline` | 0.49.5 | MIT | narumiruna | the statusline |
| `@narumitw/pi-lsp` | 0.49.3 | MIT | narumiruna | language-server diagnostics |
| `@narumitw/pi-usage` | 0.49.3 | MIT | narumiruna | the quota read path |
| `@narumitw/pi-retry` | 0.31.0 | MIT | narumiruna | transient-failure retry |
| `pi-llama-cpp` | 0.9.1 | MIT | gsanhueza | local-provider support |
| `@99percentpeople/pi-background-tasks` | 2.0.0 | MIT | 99percentpeople | the bash face of background work |
| `@nklisch/pi-plugins` | 0.3.3 | MIT | nklisch | package lifecycle |
| `pi-sandbox` | 0.6.2 | MIT | Chris Arderne | OS-level containment. **Reviewed; the guard never delegates to it** |
| `pi-hashline-edit-pro` | 1.1.0 | MIT | YuGiMob | edit trial |
| `pi-hermes-memory` | 0.9.3 | MIT | chandra447 | session search |
| `pi-web-search` | 1.3.1 | MIT | ttttmr | alternative search backend |
| `pi-opa-net` | 0.6.0 | MIT | buihongduc132 | policy-engine option |
| `pi-smart-compact` | 7.22.0 | MIT | alpertarhan | compaction summary quality |
| `pi-lean-ctx` | 3.9.17 | **Apache-2.0** | Yves Gugger | tool-output shrinking |

### Build-time only

| Package | Version | Licence |
|---|---|---|
| `typescript` | 5.9.3 | **Apache-2.0** (Microsoft) |
| `typebox` | 1.3.7 | MIT |
| `@types/node` | 24.12.4 | MIT (DefinitelyTyped) |

### Reviewed and deliberately not adopted

A token-optimiser package was reviewed and **rejected**: its licence is non-commercial, and its
design depends on four PI events that do not exist. Recorded in
[Known limitations](../limitations.md#not-ported--capabilities-that-exist-elsewhere-and-not-here) so
the decision is visible rather than inferred from absence.

---

## Licence obligations

!!! warning "This repository redistributes MIT-licensed source"
    The vendored `pi-mcp-adapter` directory contains its upstream `LICENSE` file. **Do not remove
    it**, do not strip the copyright header from any vendored file, and keep this page current when
    a vendored version changes.

    Whatever licence this repository is released under must be compatible with MIT and must preserve
    that attribution. MIT and Apache-2.0 are both compatible; a copyleft licence would need care
    around the vendored tree.

If you fork this repository, the same obligation travels with your copy.

## Related

- [Safety model](../concepts/safety-model.md#why-some-code-is-in-tree) — the vendoring rationale
- [`config/mcp.json`](../configuration/mcp.md) — the gate the patches implement
- [Generated and locked files](../configuration/not-editable.md) — `packages.lock.json`
