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
| `settings.json` *(generated)* | `~/.pi/agent/settings.json` | global | Default model, thinking, trust posture, retry, compaction, skills/prompts/packages paths, and the `subagents.watchdog` block — a key PI itself never reads, only carries, and that `pi-subagents` picks up from here rather than from `subagent.json`. See [`../docs/configuration/settings.md`](../docs/configuration/settings.md#subagentswatchdog) |
| `keybindings.json` | `~/.pi/agent/keybindings.json` | global | Key remaps. Ships empty on purpose |
| `web.json` | `~/.pi/agent/web.json` | global | Our own declared-intent file: the one pinned `search.backend` (`searxng`, `tavily`, `brave`, `exa` or `none`), for humans and `jq`-based tooling, plus `search.answerPath` — the path your search host serves search-read-and-cite on, joined to `web-search.json`'s `searxngBaseUrl`. `answerPath` ships `null`, and while it is unset the `web_answer` tool is not registered at all. Not read by `pi-web-access` itself — see `web-search.json` |
| `web-search.json` | `~/.pi/agent/web-search.json` | global | The config `pi-web-access` actually reads at runtime: pinned `provider`, `searxngBaseUrl`, SSRF posture, `allowBrowserCookies: false`, and a `toolNames.fetchContent` rename to `web_fetch` so the TRIGGER blocks in `AGENTS.md` resolve. `extensions/web/config-guard.ts` asserts this file and `web.json` agree, and that the rename is present, at every `session_start`. **`searxngBaseUrl` defaults to a SearXNG you run yourself on `127.0.0.1:8080`** (SearXNG's own default port; pick a different one for any model endpoint you run on loopback, since both are popular) — point it at your own instance, or change the pinned backend in *both* files together. The hosted backends carry no credential here: `tavily`, `brave` and `exa` read `TAVILY_API_KEY` / `BRAVE_API_KEY` / `EXA_API_KEY` from the environment (`~/.pi/secrets.env`), so a search key never enters a tracked config file. With `provider: "none"` only `web_search` goes away — `web_fetch` still works keyless, falling back to Jina Reader for pages a plain fetch cannot read. Also carries `workflow`, which pins pi-web-access's **search curator** as state rather than as something the model has to remember on every call: the package resolves the mode as `params.workflow ?? config.workflow` before falling back to its own hardcoded `summary-review`, so an unpinned key means an unattended run opens a browser page and waits for a human. The template pins `"none"`; `"auto-summary"` and `"summary-review"` are the other values. `checkSearchWorkflowPinned()` reports at `session_start` if the key ever goes missing, which is what `/curator` writing the *generated* file looks like after the next regeneration |
| `constraints.json` | `~/.pi/agent/constraints.json` | global | The hard constraints that were written down as NEVER. `config/hooks.yaml` runs `config/bin/pi-constraints-hook` on every `edit`/`write`; the script matches the **added** text against these patterns and denies with the constraint's own `reason`. Ships with an empty list on purpose — the NEVERs worth enforcing are project decisions, and belong in `<project>/.pi/constraints.json`, which the same hook merges. See [`../docs/extending/hooks.md`](../docs/extending/hooks.md) |
| `project-settings.example.json` | copied to `<repo>/.pi/settings.json` | project | Per-repo model/provider **defaults**; deep-merged over the global settings. A default is where a session starts, not where it stays — for a lead the session is held to, see the row below |
| *(none — written by `/lead-model`)* | `<project>/.pi/lead-model.json` | project | The one `routing.json` **tier** this project's lead model is pinned to, with `since` and a required `reason`. `extensions/lead-model/` re-selects the pin on any `model_select` away from it and announces the revert; `/lead-model <tier> <why>` is the only sanctioned change, and records it as a `fact`. This repo ships its own pin. Shape and live-tier assertion: `PC-30`. See [`../docs/configuration/lead-model.md`](../docs/configuration/lead-model.md) |
| `bin/dbx-token-cached` | `~/bin/dbx-token-cached` | — | TTL cache in front of Databricks OAuth. `models.json` re-executes `!command` on **every request**; this makes that a file read |
| `bin/pi-tier` | `~/bin/pi-tier` | — | Resolve a tier name to `provider/model-id` from shell/cron, with the tier's `thinkingLevel` appended as `:level`. The model string is the only place PI reads reasoning effort from, so printing the bare id would run shell aliases at the provider default while `routing.json` declared otherwise. `--thinking <tier>` still reports the level on its own |
| `bin/pi-constraints-hook` | `~/bin/pi-constraints-hook` | — | The `run` script behind `hooks.yaml`'s `constraints-edit` / `constraints-write` rules. Reads `constraints.json` from the agent dir and from `<project>/.pi/`, matches only the text an edit or write **adds**, and denies with the constraint's own reason. Zero dependencies and no import from this tree: it is spawned as a process, with the project as `cwd`, and has to work before anything is built |
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
6. **No provider failover on the working path.** `routing.json`'s `onProviderError` is
   `{"policy": "abort", "substituteProvider": false}` and is copied through the installer untouched.
   `bin/pi-check` rule PC-03 fails on a re-introduced `fallback` key. The one declared exception is
   `routing.json`'s `compaction.route`, which gives the *summariser* an ordered list of endpoints so
   a quota wall on the lead cannot also stop the session shrinking; it is announced at every hop.
   See [ADR 0001](../docs/adr/0001-no-provider-failover.md).

   `onProviderError.retry` is **not** an exception to this and is easy to misread as one. It gives
   `network` and `empty-response` one more attempt **at the same provider and the same model**
   before the same abort. Its `onEmpty` block may vary exactly one thing about that attempt — the
   reasoning effort — because measurement showed a bit-identical resend of an `empty-response` to
   be the variant that recovers least often. No provider changes, no model changes, and the
   borrowed effort is given back the moment the failure streak ends. `PC-31` *warns* when
   `empty-response` is retried with no `onEmpty.strategy` written down; it never fails a build over
   it, because that default is legal. Keys, defaults and the whole argument:
   [`routing.json` → `retry`](../docs/configuration/routing.md#retry-the-two-classes-that-are-weather-not-a-verdict).

## 60-second smoke test

```bash
jq empty config/*.json config/providers/*.json && echo "JSON ok"
bash -n config/bin/dbx-token-cached config/bin/pi-tier config/shell/pi-env.sh && echo "shell ok"
grep -n '{{' config/models.json config/routing.json   # EXPECT: no output
pi-tier --list
pi -p "reply with OK" --model "$(pi-tier light)"
```
