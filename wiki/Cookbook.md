# Cookbook

Short recipes. Each one names **the file**, **the change**, **how to check it worked** and **what
breaks if you get it wrong**. Deeper reasoning lives on the
[configuration reference](https://dresvyanskiydenis.github.io/PiON/configuration/).

> **Before you edit anything, three facts.** Ten config files — `models`, `routing`, `mcp`,
> `settings`, `guard`, `trusted-roots`, `path-defaults`, `web`, `web-search`, `quota` — are
> **generated and git-ignored**; the tracked templates are `config/<name>.default.json`. Editing the
> generated file is normal and survives a re-run; only a fresh clone falls back to the template.
> **Re-running the installer is the supported way to change configuration**
> (`./scripts/install.sh --reconfigure`), not a reinstall. And `~/.pi/agent/*` are **symlinks into
> your clone**, so editing a file in the repository changes the running agent — there is nothing to
> deploy.

**Contents:** [Routing](#routing-and-models) · [Safety](#safety-and-permissions) ·
[Context](#context-and-compaction) · [Sub-agents](#sub-agents-and-orchestration) ·
[Tools](#tools-and-integrations) · [Headless](#headless-and-scheduled-runs) ·
[Maintenance](#maintenance)

---

## Routing and models

### 1. Point a tier at a different model

**File:** `config/routing.json` (generated) — mirror it into `config/routing.default.json` to survive a fresh
clone.

```json
"tiers": {
  "light": { "model": "github-copilot/claude-sonnet-5", "thinkingLevel": "medium", "purpose": "…" }
}
```

The model id is **provider-qualified**: `<provider>/<model>`. Change the value, restart `pi`.

**Check:**

```bash
pi-tier light              # the resolved id, with the tier's thinkingLevel as a :<level> suffix
pi-tier --thinking light   # just the level
```

**What breaks:** an unqualified id (`claude-sonnet-5`) fails `bin/pi-check`'s `PC-01`. A provider
that is not present in `models.json` fails `PC-02`, and every agent bound to that tier stops
resolving. Putting the effort level in the `model` value (`<provider>/<model>:high`) instead of in
`thinkingLevel` breaks it differently and more quietly: the registry is keyed on the bare id, so
`/doctor`'s `D-04` reports the tier as unresolved even though it works.

### 2. Bind the `confidential` tier

It ships **unbound** on purpose, with an explanation in `routing.json`'s `tiersUnbound`. Asking for
an unbound tier fails loudly instead of quietly sending your material to a public endpoint.

```bash
./scripts/install.sh --section providers    # add the provider
./scripts/install.sh --section tiers        # bind the tier to one of its models
```

**Check:** `pi-tier confidential` exits `0` and prints a model id. Exit `2` means still unbound.

**What breaks:** binding `confidential` to a public provider makes the word meaningless — and the
egress ceiling that refuses a public dispatch from a confidential agent will then let it through.

### 3. Add a provider

```bash
./scripts/install.sh --section providers
```

Eight fragments ship: `github-copilot`, `openai`, `deepseek`, `qwen`, `litellm`, `databricks` and
`ollama-cloud` for those named products, and `openai-compatible` for anything serving its own model
names over an OpenAI-compatible
Chat Completions surface — a gateway, a vendor API, or a server on your own loopback. For anything else, add a fragment to `config/providers/` — see
[Adding a provider](https://dresvyanskiydenis.github.io/PiON/extending/providers/) and
[[Provider Cheat Sheet]].

**Check:** `bin/pi-check --all`, then `/doctor` inside `pi`.

### 4. Change the model `pi` opens with

**File:** `config/settings.json`

```json
"defaultProvider": "github-copilot",
"defaultModel": "claude-opus-5",
"defaultThinkingLevel": "medium"
```

`defaultModel` is **not** provider-qualified here — that field names an id *within*
`defaultProvider`. Everywhere else in this repository, model ids are qualified.

**What breaks:** a `defaultModel` the provider does not serve leaves you unable to start a session
without overriding the model first.

### 5. Make it think harder (or less) by default

**File:** `config/settings.json` → `defaultThinkingLevel` (`minimal` | `low` | `medium` | `high`),
and `thinkingBudgets` for what each level costs in tokens:

```json
"thinkingBudgets": { "minimal": 2048, "low": 6144, "medium": 12288, "high": 24576 }
```

Raising a budget raises the cost of every turn at that level, on every model. Prefer moving one
tier's `thinkingLevel` over inflating the budgets globally.

### 6. Fix "the model claims a bigger context than it delivers"

**File:** `config/models.json` → `providers.<provider>.modelOverrides.<model-id>.contextWindow`
(the id is unqualified there — it is already nested under its provider). Mirror it into
`config/models.default.json`, or into the provider fragment in `config/providers/`, to survive a
fresh clone.

```json
"providers": {
  "github-copilot": {
    "modelOverrides": { "claude-haiku-4.5": { "contextWindow": 136000 } }
  }
}
```

The rule the whole harness rests on:

```text
contextWindow = min(200000, what the endpoint actually serves)
```

Not what the provider's marketing page says; what *your* endpoint serves. A proxy, a gateway or a
Copilot seat frequently serves less than the upstream model's headline number.

**What breaks:** an overstated window means compaction fires too late and the provider rejects the
request instead. See
[Context windows](https://dresvyanskiydenis.github.io/PiON/concepts/context-windows/).

---

## Safety and permissions

### 7. What still asks, and what runs with no prompt at all

**As of the 2026-08-14 deny-list inversion, nothing in the guard prompts you, ever — interactively
or headless.** There is no allowlist and no unattended-execution mode to set. Every program runs
unattended unless the specific *command shape* it is used for is one of:

- `DB-*` — one of eight catastrophic shapes (`rm -rf /`, fork bomb, `dd of=/dev/…`, `mkfs`, redirect
  onto a raw disk, `chmod -R 777 /`, `curl … | sh`, shutdown). Mostly not overridable.
- `GIT-REWRITE` (`filter-repo` / `filter-branch`) and `GIT-FORCE-PROTECTED` (a force-push onto a
  protected branch). Overridable with a written justification.

If you are being refused and it is not one of those two families, the guard is not the cause — check
`config/hooks.yaml` for a rule your team added.

`SEC-*` (credential paths) was on that list until 2026-08-15 and now only records. A credential file
can be read into the model's context and sent to the provider, and no runtime control here prevents
it — see [Safety model](https://dresvyanskiydenis.github.io/PiON/concepts/safety-model/#credential-reads-are-no-longer-refused).

### 8. Record — but do not block — a credential read, a privileged command, an out-of-tree write, or a generic dispatch

**Nothing to configure; this is what the guard does by default.** `SEC-*` (a credential path on any
tool), `PRV-*` (`sudo`, `chmod 777`, `pkill -9`, `killall`), `FS-*` (a bash write whose target
resolves outside the project) and `RTE-*` (a generic agent dispatched where a specialist matched) are
all **audit-only**: permitted, and written to the session's audit log as a `guard.observed` entry,
with nothing returned to the model.

**If you need one of these to actually refuse for your own workflow**, the guard will not do it —
write a `block` rule for the shape you care about in `config/hooks.yaml`. Hooks stack on
the guard and can only add denial, never remove it.

### 9. Protect more branches from destructive git

**File:** `config/guard.json` → `protectedBranches` (`["main", "master"]` ships).

`GIT-FORCE-PROTECTED` against one of these needs a **written justification**, not a flag. That is
deliberate: the hatch is a sentence a human wrote, so it survives review.

### 10. Override a blocked git rewrite or force-push, with a written justification

There is no environment variable that pre-approves a run — `PI_GUARD_APPROVE` was removed outright
in the same change, along with `PI_GUARD_SESSION_ALLOWLIST`. What is left is the per-command hatch,
and only for the two `GIT-*` rules and two of the eight `DB-*` ones:

```bash
# PI-JUSTIFY(GIT-REWRITE): throwaway clone made for this rewrite, not the checkout
git filter-repo --mailmap mailmap.txt --force
```

The comment is stripped before the command runs and the justification is written to the audit log.
It does nothing for the `SEC-*` family — since 2026-08-15 those rules record rather than refuse, so
there is no refusal for a justification to unlock.

### 11. Let a project contribute its own extensions and hooks

**File:** `config/trusted-roots.json` — list the roots you own.

```json
{ "version": 1, "roots": ["~/work", "~/src"] }
```

Everything outside those roots stays *undecided*, so PI's own trust prompt still runs.
`defaultProjectTrust` stays `"ask"` in `config/settings.json`; nothing in the repository enforces
that mechanically, which is exactly why it is worth not undoing casually.

**Note:** path trust and **MCP** trust are different questions, and being inside a trusted root
grants nothing to MCP — recipe 16.

---

## Context and compaction

### 12. Change when compaction fires

**File:** `config/settings.json`

```json
"compaction": { "enabled": true, "reserveTokens": 20000, "keepRecentTokens": 20000 }
```

The trigger is `contextTokens > contextWindow − reserveTokens`.

**What breaks:** `reserveTokens` is a **global scalar**, one number for every model in the tree. Size
it for a one-million-token model and a 200 000-token model compacts almost immediately, or never. The
per-model lever is `modelOverrides.<id>.contextWindow` (recipe 6), never this.

Raise `keepRecentTokens` when the agent keeps forgetting the last few steps right after a
compaction.

### 13. See where the context actually went

```text
/context            # preamble vs compactable dialogue, separated
/compaction-status  # loop-guard state
/ctx-dump           # exactly what was injected into the system prompt
```

`/context` separating the fixed preamble from the dialogue is the point: a preamble you cannot
compact is a different problem from a transcript you can.

---

## Sub-agents and orchestration

### 14. Add your own sub-agent

Drop a Markdown file with front matter into `agents/` (or `agents-private/`, which is git-ignored):

```yaml
---
name: my-agent          # must match the filename
description: …          # this text is what the router matches against
tools: [read, grep]
---
```

Thirteen agents ship — twelve specialists plus the `general-purpose` catch-all. Full front-matter
reference: [Adding a sub-agent](https://dresvyanskiydenis.github.io/PiON/extending/subagents/).

**Check:** `/agents` inside `pi`.

**What breaks:** `name` not matching the filename; a `fallbackModels` key, which `bin/pi-check`'s
`PC-05` rejects outright because failover is not a thing here; `bash` in `tools` when you meant to
give a read-only agent read-only tools.

### 15. Change how many sub-agents run at once, and how deep

**File:** `config/dispatch.json`

```json
{ "maxDepth": 2, "concurrencyDefault": 3, "defaultTier": "strong", "defaultTimeoutMs": 1800000 }
```

`maxDepth: 2` is **not overridable** — a written justification cannot make a fourth level of nesting
safe. Per-provider concurrency lives in `config/routing.json` → `concurrency`.

---

## Tools and integrations

### 16. Let a project's `.mcp.json` be used at all

Project MCP config is **default-deny**, keyed on the path *and* the sha256 of the file:

```bash
pi-mcp-approve .              # approve this directory's current MCP config
pi-mcp-approve --status .     # exit 0 = allowed, 1 = refused
pi-mcp-approve --list
```

Change the file and the approval no longer matches — on purpose.

**Why it is separate from path trust:** without this gate, `git clone <hostile> && cd && pi` is
enough to spawn a stdio server holding every token in your environment, with **no tool call for the
guard to see**.

### 17. Add your own MCP server

**File:** `config/mcp.json` (generated) — the tracked template is `config/mcp.default.json`, and
`config/mcp.example.json` has worked examples of both an HTTP and a stdio server.

For a stdio server, wrap the command:

```json
"command": "mcp-stdio-guard",
"args": ["node", "/path/to/server.js"]
```

The wrapper re-execs the server through `env -i` plus a small baseline allowlist, so it inherits
`HOME`/`PATH`/proxy variables and *not* your API keys. Anything it genuinely needs is named
explicitly in `MCP_STDIO_EXTRA_ENV`.

For `context7` or `playwright` specifically, let the installer do it:
`./scripts/install.sh --section tools`. That step stands down entirely when `config/mcp.json` already
exists, so it can never overwrite a file you wrote by hand.

Full walkthrough:
[Adding an MCP server](https://dresvyanskiydenis.github.io/PiON/extending/mcp-servers/).

### 18. Add your own skill

No skill is loaded by default — the *loading machinery* is what ships, plus one worked example under
`examples/skills/` that you copy in if you want it. Put yours in
`skills/` in the clone (git-ignored, and the installer offers to create it), or in
`~/.pi/agent/skills/<name>/SKILL.md` — the installer links one to the other, so those are the same
directory. That path is the single entry in `config/settings.json` → `skills`; any other root you
invent has to be added there, or PI merges it last and it loses every name collision.

PI parses exactly three front-matter fields: `name`, `description`,
`disable-model-invocation`. **`allowed-tools` is inert** — it is accepted and ignored, so a skill
ported from another agent may be less restricted than its front matter suggests. Quote any
`description` containing a colon, or the YAML parser rejects the file.

**Check:** `/skill:<name>` exists, and `/doctor` → `D-02` lists the skill roots that were actually
discovered. Full walkthrough with a worked example:
[Writing a skill](https://dresvyanskiydenis.github.io/PiON/extending/skills/).

### 19. Point web search at your own instance

**File:** `config/web-search.json`

```json
{ "provider": "searxng", "searxngBaseUrl": "http://127.0.0.1:8080", "webSearch": { "enabled": true } }
```

**What breaks:** `provider` here must equal `search.backend` in `config/web.json`. A mismatch is
checked on every `session_start` and refuses the session — two files, one truth, verified rather
than assumed.

Leave `allowBrowserCookies` at `false`. `true` lets the fetcher reuse your browser cookies, so an
agent following a link retrieves pages *as you*, authenticated.

### 20. Give a long-running command more time

**File:** `config/bash-timeouts.json`

```json
{ "defaultTimeoutSeconds": 120, "ceilingSeconds": 3600, "maxLines": 2000, "maxBytes": 51200 }
```

Raise `defaultTimeoutSeconds` for a slow test suite. `maxLines` / `maxBytes` cap what a command may
return into context — a build that prints 40 000 lines is a context problem, not a timeout problem.

### 21. Turn off the noise

| Want gone | File | Change |
|---|---|---|
| Per-session digests | `config/digest.json` | `"enabled": false` |
| Quota meter in the status line | `config/quota.json` | `"enabled": false` |
| Task-list nudges | `config/tasks.json` | raise `nudgeEveryTurns` (ships `6`) |
| Cache-miss notices | `config/settings.json` | `"showCacheMissNotices": false` |

---

## Headless and scheduled runs

### 22. Run it from cron or a scheduler — correctly

**Never use bare `pi -p` unattended.** It exits `0` on a failed turn.

```bash
#!/usr/bin/env bash
set -uo pipefail          # NOT -e: the exit code is the whole point

code=0
~/pi-config/bin/pi-run -p "$(cat prompt.txt)" || code=$?

case $code in
  0)      exit 0 ;;
  23|91)  echo "compaction loop — the prompt is probably growing without bound" >&2 ;;
  20)     echo "the turn failed — read the provider block in the output" >&2 ;;
  22)     echo "protocol drift — pi's stream shape changed" >&2 ;;
esac
exit "$code"
```

Full table: [Exit codes](https://dresvyanskiydenis.github.io/PiON/reference/exit-codes/).

### 23. Make a headless run refuse to guess

Nothing to set — the guard never guesses. `DB-*`, `GIT-REWRITE` and `GIT-FORCE-PROTECTED`
refuse the same way headless as interactively, with a named reason; everything else runs unattended
either way, because none of it ever asked for confirmation in the first place. If a scheduled run
needs to refuse rather than proceed on an *ambiguous* signal — a missing credential, an unresolved
model — that is `bin/pi-run`'s job (recipe 22), not the guard's.

---

## Maintenance

### 24. Check the install is still coherent

```bash
~/pi-config/bin/pi-check --all        # 31 repository invariants
./scripts/postinstall-verify.sh       # the install itself
/doctor                               # inside pi: modules loaded vs expected-but-absent
```

`pi-check` exits `1` for *your repository is wrong* and `2` for *the checker could not run*. Treating
them the same hides broken tooling behind a red build.

### 25. Change your mind about anything you answered at install time

```bash
./scripts/install.sh --reconfigure                 # the whole interview again
./scripts/install.sh --section providers           # one section
./scripts/install.sh --repair                      # re-link and re-verify, ask nothing
./scripts/install.sh --dry-run                     # print every action, perform none
```

Sections: `providers` · `tiers` · `agent` · `safety` · `tools` · `shell` · `maintenance`.

### 26. Remove it

```bash
./scripts/uninstall.sh                 # remove the agent; keep sessions and credentials
./scripts/uninstall.sh --purge         # also remove ~/.pi entirely        (asks first)
./scripts/uninstall.sh --purge-state   # also remove the runtime state dir (asks first)
```

It reads the install manifest back, so it removes only what the installer created. A foreign file
sitting at one of those paths is reported, not deleted.

---

See also: [[Troubleshooting]] · [[FAQ]] · [[Provider Cheat Sheet]]
