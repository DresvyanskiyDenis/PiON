# `config/` — the pi configuration tree

Everything in this directory is **installed by symlink** into `~/.pi/agent/` by
`scripts/install.sh`. Editing a file here changes the live agent; there is no build step and no
second copy.

Two files are **generated, not tracked**: `models.json` and `routing.json` are produced by the
installer from the `*.default.json` templates plus `providers/*.json` plus your answers, and are
git-ignored so a fork can never publish your endpoints. The contract that describes how is
[`providers/README.md`](providers/README.md).

| File | Installed as | Scope | What it decides |
|---|---|---|---|
| `providers/*.json` | *not installed* | — | One self-describing template fragment per provider: its models.json block, the questions the installer asks, its credentials, its egress class and concurrency cap, and the measured facts behind each setting |
| `providers/README.md` | *not installed* | — | **The installer contract.** Fragment schema, substitution rules, merge algorithm |
| `models.default.json` | *not installed* | — | Generic working default: public GitHub Copilot only, zero configuration |
| `routing.default.json` | *not installed* | — | Generic tier bindings referencing only what `models.default.json` provides |
| `path-defaults.default.json` | *not installed* | — | The unconfigured default: tier `strong`, every channel `allow` |
| `models.json` *(generated)* | `~/.pi/agent/models.json` | global | The active providers, their wire APIs, credential *references*, `compat` blocks, honest context windows |
| `routing.json` *(generated)* | `~/.pi/agent/routing.json` | global | **Semantic tiers** (`strong`/`light`/`confidential`), per-provider egress class and concurrency cap. Not a pi file — read by our extensions and by `bin/pi-tier` |
| `path-defaults.json` *(generated)* | `~/.pi/agent/path-defaults.json` | global | One default tier and one declarative per-channel egress policy (`web`/`mcp`/`publicModels`), applied at every `session_start`. Optional — a missing file is an unconfigured install, not an error. See `bin/pi-check` rule PC-20 for its shape assertion |
| `settings.json` | `~/.pi/agent/settings.json` | global | Default model, thinking, trust posture, retry, compaction, skills/prompts/packages paths |
| `keybindings.json` | `~/.pi/agent/keybindings.json` | global | Key remaps. Ships empty on purpose |
| `web.json` | `~/.pi/agent/web.json` | global | Our own declared-intent file: the one pinned `search.backend` (`searxng`, `tavily`, `brave`, `exa` or `none`), for humans and `jq`-based tooling, plus `search.answerPath` — the path your search host serves search-read-and-cite on, joined to `web-search.json`'s `searxngBaseUrl`. `answerPath` ships `null`, and while it is unset the `web_answer` tool is not registered at all. Not read by `pi-web-access` itself — see `web-search.json` |
| `web-search.json` | `~/.pi/agent/web-search.json` | global | The config `pi-web-access` actually reads at runtime: pinned `provider`, `searxngBaseUrl`, SSRF posture, `allowBrowserCookies: false`, and a `toolNames.fetchContent` rename to `web_fetch` so the TRIGGER blocks in `AGENTS.md` resolve. `extensions/web/config-guard.ts` asserts this file and `web.json` agree, and that the rename is present, at every `session_start`. **`searxngBaseUrl` defaults to a SearXNG you run yourself on `127.0.0.1:8080`** (SearXNG's own default port; pick a different one for any model endpoint you run on loopback, since both are popular) — point it at your own instance, or change the pinned backend in *both* files together. The hosted backends carry no credential here: `tavily`, `brave` and `exa` read `TAVILY_API_KEY` / `BRAVE_API_KEY` / `EXA_API_KEY` from the environment (`~/.pi/secrets.env`), so a search key never enters a tracked config file. With `provider: "none"` only `web_search` goes away — `web_fetch` still works keyless, falling back to Jina Reader for pages a plain fetch cannot read |
| `project-settings.example.json` | copied to `<repo>/.pi/settings.json` | project | Per-repo model/provider pinning; deep-merged over the global settings |
| `bin/dbx-token-cached` | `~/bin/dbx-token-cached` | — | TTL cache in front of Databricks OAuth. `models.json` re-executes `!command` on **every request**; this makes that a file read |
| `bin/pi-tier` | `~/bin/pi-tier` | — | Resolve a tier name to `provider/model-id` from shell/cron, with the tier's `thinkingLevel` appended as `:level`. The model string is the only place PI reads reasoning effort from, so printing the bare id would run shell aliases at the provider default while `routing.json` declared otherwise. `--thinking <tier>` still reports the level on its own |
| `shell/pi-env.sh` | sourced from `~/.zshrc` | — | Env posture: telemetry off, proxy/CA, secret file location. Contains no secrets |

## Hard rules for this directory

1. **No secret values, ever.** Only `$ENV_VAR` and `!command` references. `bin/pi-check` (rule
   PC-06) greps for key-shaped strings and fails the build.
2. **No `<PLACEHOLDER>`-style all-caps token may survive anywhere under `config/`.** `bin/pi-check` rule PC-10
   rejects any `<[A-Z][A-Z0-9_]*>` outside a shell comment. Template placeholders are therefore
   `{{mustacheCase}}` (installer-substituted, only in `providers/*.json`) or `<lowercase-words>`
   (a value you type). See [`providers/README.md`](providers/README.md) §3.
3. **No bare model id outside `routing.json` and `models.json`.** Agents, skills and scripts
   reference a **tier**.
4. **`defaultProjectTrust` stays `"ask"`.** Setting it to `"always"` globally disables the gate that
   stops a cloned repository executing its own TypeScript.
5. `models.json` and `settings.json` are **plain JSON, not JSON5** — pi will not parse comments. All
   commentary for the provider blocks lives in `providers/*.json`'s `notes[]`, block by block.
6. **No provider failover, anywhere.** `routing.json`'s `onProviderError` is `{"policy": "abort",
   "substituteProvider": false}` and is copied through the installer untouched. `bin/pi-check` rule
   PC-03 fails on a re-introduced `fallback` key.

## 60-second smoke test

```bash
jq empty config/*.json config/providers/*.json && echo "JSON ok"
bash -n config/bin/dbx-token-cached config/bin/pi-tier config/shell/pi-env.sh && echo "shell ok"
grep -n '{{' config/models.json config/routing.json   # EXPECT: no output
pi-tier --list
pi -p "reply with OK" --model "$(pi-tier light)"
```
