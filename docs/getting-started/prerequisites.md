# Prerequisites

## Required

| Thing | Version | Why |
|---|---|---|
| **PI** | `0.84.0` | Pinned in `config/pi-release.lock`. The extensions read internal behaviour of this release; see [the version pin](#why-pi-is-pinned). |
| **Node.js** | `≥ 22.19.0` | `package.json` `engines`. The extensions are TypeScript executed by Node's type-stripping loader — no build step, no `tsc` output. |
| **git** | any recent | Worktree isolation, the session index's git probe, and the install script's stable-symlink logic. |
| **A POSIX shell** | bash/zsh | `scripts/install.sh` and the helpers in `config/bin/` are bash. |

## Strongly recommended

| Thing | Used by |
|---|---|
| **`jq`** | [`pi-tier`](../operations/cli.md#pi-tier) requires it. `scripts/install.sh` falls back to `awk` when it is absent, but nothing else does. |
| **A credential for at least one provider** | Nothing starts a session usefully without one. A provider whose credential is missing does **not** stop `pi` from starting — it fails only when that provider is selected. |

## Optional

| Thing | Enables |
|---|---|
| An OpenAI-compatible local server on `127.0.0.1:8888` | The `local` tier. Absent, it degrades to a single warning line, never a fatal. See [`credentials`](../extensions/credentials.md). |
| `typescript-language-server`, a Python language server | `config/pi-lsp.json`, consumed by the `@narumitw/pi-lsp` package. Config only — this repository ships no LSP extension code. |
| A classic GitHub PAT with `read:user` | The Copilot [quota meter](../extensions/quota.md). Without it the statusline segment is simply hidden. |

## Why PI is pinned

`config/pi-release.lock` names `0.84.0` and `scripts/install.sh` checks it. This is not caution for
its own sake. A material amount of this harness is written against behaviour that PI's public API
does not describe, verified by reading the shipped `dist/` of that exact release. Examples that are
load-bearing:

- `shouldCompact` is `contextTokens > contextWindow - reserveTokens`, and `reserveTokens` is a
  **global scalar**, not per-model. The whole [context-window rule](../concepts/context-windows.md)
  follows from that one fact.
- `resources_discover` is **additive only** — a handler can add skill roots, never remove them, and
  what it adds is appended behind every settings-declared root. So
  [`skill-mask`](../extensions/skill-mask.md) could never mask, and the roots it once contributed
  were collapsed into the single one `settings.json` declares.
- PI's skill frontmatter reader parses exactly three fields; `allowed-tools` is read by nothing.
  Hence [`skills-lint`](../extensions/skills-lint.md) warns instead of enforcing.
- An extension **cannot** abort a headless run from the inside. Hence
  [`bin/pi-run`](../operations/cli.md#pi-run).

Bumping PI is therefore a real task, not a version-number edit. `bin/api-probe.mjs` and
`config/api-surface.lock.json` exist to make the drift visible: run the probe after a bump and it
reports which of the API surfaces this tree depends on have changed shape.

## What is *not* required

- **No admin rights.** `scripts/install.sh` writes only under `$HOME` and never calls `sudo`.
- **No network at install time**, if you pre-stage the artefacts: `--offline --offline-dir DIR`.
- **No `curl … | sh`.** Ever. `npm` is always invoked with `--ignore-scripts`.
