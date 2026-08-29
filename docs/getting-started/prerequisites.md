# Prerequisites

## Required

| Thing | Version | Why |
|---|---|---|
| **PI** | `0.84.0` | Pinned in `config/pi-release.lock`. The extensions read internal behaviour of this release; see [the version pin](#why-pi-is-pinned). |
| **Node.js** | `≥ 22.19.0` | `package.json` `engines`. The extensions are TypeScript executed by Node's type-stripping loader — no build step, no `tsc` output. |
| **git** | any recent | Worktree isolation, the session index's git probe, and the install script's stable-symlink logic. |
| **A POSIX shell** | bash/zsh | `scripts/install.sh` and the helpers in `config/bin/` are bash. |
| **`jq`** | any | [`pi-tier`](../operations/cli.md#pi-tier) exits 1 without it, and `pi-tier` is step 2 of [first run](first-run.md) and the `$(pi-tier strong)` in every documented invocation. `scripts/install.sh` itself never calls it — the installer will finish on a machine where `pi-tier` then cannot run. |

## Strongly recommended

| Thing | Used by |
|---|---|
| **A credential for at least one provider** | Nothing starts a session usefully without one. A provider whose credential is missing does **not** stop `pi` from starting — it fails only when that provider is selected. |

The installer asks which provider to configure and writes `config/models.json` from one of the
eight fragments in `config/providers/`. Have the answers ready before you start:

| Fragment | You will be asked for | Pick it when |
|---|---|---|
| **`github-copilot`** (the default) | an endpoint and a tenant | you have a Copilot subscription. PI already ships this provider, so the fragment overrides PI's catalogue instead of defining one. |
| **`openai-compatible`** | a base URL, the name of the environment variable holding the key, and two model ids with their context windows | anything that speaks `/v1/chat/completions` under its own model names — a **LiteLLM** proxy, vLLM, OpenRouter, or a router someone in your organisation runs. This is the fragment most people arrive through, and [it takes exactly one gateway](../configuration/openai-compatible.md). |
| **`openai`** | which way you buy the models: a pay-as-you-go API key, or a ChatGPT Plus/Pro sign-in | you buy GPT-5.6 from OpenAI directly. On the subscription branch there is no key to supply — `/login` does it. |
| **`deepseek`** | whether you go straight to `api.deepseek.com` or through a proxy of your own | you call DeepSeek directly. The fragment exists to correct the price: PI's bundled rates for these ids were behind the vendor's page. |
| **`qwen`** | which Model Studio deployment you call — Singapore, Beijing, or a workspace-scoped host | you buy Qwen per token from Alibaba Cloud. Not the same as PI's built-in `qwen-token-plan`, which is the flat-rate plan. |
| **`ollama-cloud`** | how many requests your plan will run at once | you use the **hosted** ollama.com. A local ollama is `openai-compatible` with a loopback URL. |
| **`databricks`** | a workspace host, an auth method, one or two serving endpoints, and how each one bills | your models are served from Databricks. Egress is fixed at `confidential`. Pay-per-token endpoints are the same host and token as provisioned ones; only the billing question differs. |

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
