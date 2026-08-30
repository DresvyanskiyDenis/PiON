# Configuration

Everything this harness does is decided by files in one directory: `config/` inside your clone.
This section documents every one of them — what each key does, what it ships as, what a sensible
different answer would be, and what breaks if you get it wrong.

Three facts govern the whole section. They are repeated on every page that needs them, because
each one has cost somebody an afternoon.

---

## Fact 1 — the repo *is* the live config

There is no copy step and no build step. The installer creates symlinks:

```
~/.pi/agent/settings.json  ->  <your clone>/config/settings.json
~/.pi/agent/models.json    ->  <your clone>/config/models.json
~/.pi/agent/routing.json   ->  <your clone>/config/routing.json
~/.pi/agent/extensions     ->  <your clone>/extensions/
```

Editing `~/.pi/agent/settings.json` **is** editing `config/settings.json` in the repository. Both
paths appear throughout the docs; they are the same bytes. The full tree is in
[Configuration layout](../getting-started/config-layout.md).

Changes take effect on the **next `pi` start**. Nothing is watched or hot-reloaded.

---

## Fact 2 — generated vs tracked

Eleven files come in pairs. `config/<name>.default.json` is **tracked** — the shipped template, read by
the installer and never written by it. `config/<name>.json` is **generated** — yours, produced from
that template plus your answers, and git-ignored.

| Generated (git-ignored) | Built from |
|---|---|
| `config/models.json` | `models.default.json` + the `config/providers/*.json` fragments you selected + your answers |
| `config/routing.json` | `routing.default.json` + your tier choices |
| `config/mcp.json` | `mcp.default.json` (ships no servers) + whatever you picked at the MCP step |
| `config/settings.json` | `settings.default.json` + default provider, model, thinking level, theme, editor, TUI mode |
| `config/guard.json` | `guard.default.json` + your protected branches |
| `config/trusted-roots.json` | `trusted-roots.default.json` + the roots you named, plus `~/pi-config` |
| `config/path-defaults.json` | `path-defaults.default.json` — a single default tier and egress policy, not per-root |
| `config/web.json`, `config/web-search.json` | their templates + your search-backend answer |
| `config/quota.json` | `quota.default.json` + whether you want the meter |
| `config/subagent.json` | `subagent.default.json` — no interview question; raise it by hand if your provider allows more |

!!! warning "Hand-editing a generated file is supported. It is the *template* a fresh clone reads"
    Editing `config/models.json` directly is a normal, expected thing to do — several pages here tell
    you to, and a re-run **patches** the file rather than resetting it, so your edit survives.

    What does not survive is a fresh clone, or `--repair` on a machine where the generated file is
    absent: both start from the template again. **If an edit has to survive that, make it in
    `config/<name>.default.json`** or in the provider fragment (`config/providers/<id>.json`).

    The generated half is git-ignored so that the first person who installs and then commits does not
    publish their own endpoints, home directory or chosen model. Never `git add -f` one.

Everything else in `config/` is tracked with no template twin, and editing it in place is the normal
workflow.

---

## Fact 3 — re-running the installer is how you reconfigure

`scripts/install.sh` is idempotent. It detects an existing installation and offers to redo one
section rather than starting over — that is the intended way to change a provider endpoint, add a
provider, or rebind a tier. See [Installation](../getting-started/install.md) for the real flags
and flow.

You do not have to use it. Every file it writes is plain JSON you may edit by hand, subject to
Fact 2.

---

## Where do I change…?

| I want to… | File | Page |
|---|---|---|
| add a provider, or point one at a different endpoint | `config/models.json` | [models.json](models.md) |
| fix a model that runs out of context too late | `modelOverrides` in `config/models.json` | [models.json](models.md#modeloverrides) |
| change which model `light` (or any tier) uses | `config/routing.json` | [routing.json](routing.md) |
| declare where a provider's traffic goes | `egress` in `config/routing.json` | [routing.json](routing.md#egress) |
| stop two dispatches thrashing one endpoint | `concurrency` in `config/routing.json` | [routing.json](routing.md#concurrency) |
| change the default model or thinking level | `config/settings.json` | [settings.json](settings.md) |
| make compaction fire earlier or later | `contextWindow`, then `compaction.reserveTokens` | [settings.json](settings.md#compaction) · [Context windows](../concepts/context-windows.md) |
| change the declared auto-compact threshold, a flat 200 000 on every model | `threshold` in `config/compaction.json` | [Session lifecycle](sessions.md#threshold-the-flat-200-000) |
| protect more branches from force-push | `protectedBranches` in `config/guard.json` | [guard.json](guard.md#protectedbranches) |
| raise the timeout for a long build | `config/bash-timeouts.json` | [Tool behaviour](tools.md#bash-timeoutsjson) |
| add a declarative block/confirm/warn rule | `config/hooks.yaml` | [Tool behaviour](tools.md#hooksyaml) |
| change the web-search backend | `config/web.json` **and** `config/web-search.json` | [Tool behaviour](tools.md#web) |
| add an MCP server | `config/mcp.json` | [mcp.json](mcp.md) |
| add your own skill | `skills` in `config/settings.json` | [Adding a skill](../extending/skills.md) |
| add your own sub-agent | `agents/` + `config/dispatch.json` | [dispatch.json](dispatch.md) |
| limit how deep sub-agents may nest | `maxDepth` in `config/dispatch.json` | [dispatch.json](dispatch.md#maxdepth) |
| raise (or lower) how many children run at once inside one parallel batch | `globalConcurrencyLimit` in `config/subagent.json` | [Sub-agents](../extending/subagents.md#concurrency-limits-what-each-one-actually-bounds) |
| change what the model is told the `subagent` tool does | `config/subagent-tool-description.md` | [Sub-agents](../extending/subagents.md#the-description-the-model-reads) |
| turn off session digests | `config/digest.json` | [Session lifecycle](sessions.md#digestjson) |
| auto-trust a directory root | `config/trusted-roots.json` | [Paths and trust](paths-and-trust.md) |
| set a per-project default model | `<project>/.pi/settings.json` | [Paths and trust](paths-and-trust.md#per-project-settings) |
| use a proxy or a corporate CA bundle | `config/shell/pi-env.sh` | [Environment](environment.md) |
| point a gateway or loopback endpoint at a different port | `config/models.json` | [`models.json`](models.md) |
| add a language server | `config/pi-lsp.json` | [Tool behaviour](tools.md#pi-lspjson) |
| change what the statusline shows | `config/pi-statusline.json` | [Tool behaviour](tools.md#pi-statuslinejson) |

Task-shaped versions of these, with the commands, live in the
[Cookbook](https://github.com/DresvyanskiyDenis/PiON/wiki/Cookbook) on the wiki.

---

## The full file list

### Configured during installation

| File | Generated? | Controls |
|---|---|---|
| [`models.json`](models.md) | **yes** | providers, endpoints, model catalogues, `modelOverrides`, `compat` |
| [`routing.json`](routing.md) | **yes** | the three tiers, `egress` classes, per-provider `concurrency`, `onProviderError` |
| [`mcp.json`](mcp.md) | **yes** | MCP servers, `hostConfigDiscovery`, `directTools` |
| [`settings.json`](settings.md) | **yes** | PI's own behaviour: default model, thinking, trust, compaction, retry, resource paths |
| [`guard.json`](guard.md) | **yes** | shell-execution safety: protected branches, dispatch-tool names for the routing observer |
| [`trusted-roots.json`](paths-and-trust.md), [`path-defaults.json`](paths-and-trust.md) | **yes** | which filesystem roots are auto-trusted, and the single default tier/egress policy |
| [`web.json`](tools.md#web), [`web-search.json`](tools.md#web) | **yes** | search backend, SSRF policy, cookie policy, tool names |
| [`quota.json`](sessions.md#quotajson) | **yes** | quota metering for metered providers |
| [`subagent.json`](../extending/subagents.md#concurrency-limits-what-each-one-actually-bounds) | **yes** | `pi-subagents`' own per-batch concurrency cap, the now-dormant legacy `parallel` keys, and an optional [`fleetKeybindings`](../extending/subagents.md#fleetkeybindings-one-block-two-views) block |
| [`pi-lsp.json`](tools.md#pi-lspjson) | no | language servers |
| [`shell/pi-env.sh`](environment.md) | no | environment, secret *references*, proxy, CA bundle |

### Not asked at install — tune whenever

| File | Controls |
|---|---|
| [`compaction.json`](sessions.md#compactionjson) | loop guard, pinned instruction sources, the flat 200 000 auto-compact threshold |
| [`digest.json`](sessions.md#digestjson) | end-of-session summaries |
| [`bash-timeouts.json`](tools.md#bash-timeoutsjson) | default and ceiling timeouts, output truncation |
| [`dispatch.json`](dispatch.md) | sub-agent depth, default tier/egress, agent registries, matching |
| [`hooks.yaml`](tools.md#hooksyaml) | declarative block / confirm / warn / run rules |
| [`constraints.json`](../extending/hooks.md) | banned patterns the `edit`/`write` hooks refuse, per project |
| [`tasks.json`](sessions.md#tasksjson) | task-list nudge cadence |
| [`keybindings.json`](tools.md#keybindingsjson) | TUI key bindings |
| [`pi-statusline.json`](tools.md#pi-statuslinejson) | statusline segments |
| [`project-settings.example.json`](paths-and-trust.md#per-project-settings) | template for per-project overrides |
| [`subagent-tool-description.md`](../extending/subagents.md#the-description-the-model-reads) | the `subagent` tool's model-facing description — roles, call protocol, width budget |

### Do not edit

[`api-surface.lock.json`](not-editable.md), [`packages.lock.json`](not-editable.md),
[`tools.declared.json`](not-editable.md), `pi-release.lock`. These are records, not settings.
Editing one to silence a check removes the check without fixing anything —
see [Generated and locked files](not-editable.md).
