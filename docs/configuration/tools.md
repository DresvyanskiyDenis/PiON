# Tool behaviour — bash, hooks, web, LSP, TUI

Six files that shape what the agent's tools do. All are safe to edit in place. Only the two web
files are asked about during installation — and those two are *generated* from
`*.default.json` templates, so an edit that must survive a fresh clone goes in the template. The
rest are tracked directly.

---

## `bash-timeouts.json`

Read by [`extensions/bash`](../extensions/bash.md) and by the timeout package underneath it.

```json
{
  "version": 1,
  "defaultTimeoutSeconds": 120,
  "ceilingSeconds": 3600,
  "minTimeoutSeconds": 1,
  "maxLines": 2000,
  "maxBytes": 51200
}
```

| Key | Ships | Meaning |
|---|---|---|
| `defaultTimeoutSeconds` | `120` | Applied when the model asks for no timeout |
| `ceilingSeconds` | `3600` | The **maximum** a model may ask for. One hour |
| `minTimeoutSeconds` | `1` | Floor |
| `maxLines` | `2000` | Output beyond this is truncated |
| `maxBytes` | `51200` | 50 KiB. Whichever limit is hit first wins |

**Raising a timeout for a long build** is the common case, and there are two ways to do it. The
model can ask for a longer timeout on a single call, up to `ceilingSeconds` — that is the right
answer for one slow command. Raising `defaultTimeoutSeconds` is the right answer when *most* of
your commands are slow.

**What breaks if you get it wrong:** a `defaultTimeoutSeconds` that is too low turns every real
build into a spurious failure, and the model will usually respond by retrying it — twice the wall
clock, same result. Too high and a hung command holds the session for that long with no output.
The `ceilingSeconds` cap exists because a model asked for 24 hours once and it was not a joke.

The truncation limits are the ones people forget. A command that emits 50 MB of log does not fill
your context — `maxBytes` cuts it — but the *interesting* part is often at the end, and the cut
takes the tail. Pipe through `tail`, `rg` or `jq` rather than raising `maxBytes`. For genuinely
large results there is [`expand_result`](../extensions/big-results.md), which externalises an
oversized result and hands back a handle.

---

## `hooks.yaml`

Read by [`extensions/hooks`](../extensions/hooks.md). **This is where you add your own rules** —
do not edit a guard gate.

Five fields per rule: `event`, `match.tool`, `match.pattern`, `action`, `reason` — plus a `run`
block for the one action that shells out.

```yaml
version: 1
rules:
  - id: no-force-push-main
    event: tool_call
    match: { tool: bash, pattern: 'git\s+push\b.*(--force|-f)\b.*\b(main|master)\b' }
    action: block
    reason: "Force-pushing main/master is blocked. Push to a feature branch."

  - id: confirm-npm-install
    event: tool_call
    match: { tool: bash, pattern: '(^|[;&|]\s*)npm\s+(i|install)\b' }
    action: confirm
    reason: "Run npm install anyway?"

  - id: remind-worktree
    event: input
    match: { pattern: '\b([Ii]mplement|[Rr]efactor|[Ff]ix the bug)\b' }
    action: warn
    reason: "Reminder: coding work happens in a git worktree, never the primary checkout."

  - id: preflight-before-remote-job
    event: tool_call
    match:
      tool: bash
      pattern: 'databricks\s+jobs\s+run-now\b|databricks\s+bundle\s+deploy\b|gcloud\s+\S+\s+jobs\s+submit\b|aws\s+batch\s+submit-job\b|kubectl\s+create\s+job\b'
    action: confirm
    reason: "A local run against real, committed input should have passed first — submit anyway?"
```

| Field | Values |
|---|---|
| `event` | `tool_call` (before a tool runs) or `input` (on your message, before the model sees it) |
| `match.tool` | the tool name. Omit on an `input` rule |
| `match.pattern` | a **JavaScript** `RegExp` source string |
| `action` | `block` \| `confirm` \| `warn` \| `run` |
| `reason` | shown to the model and to you. Write it as an instruction, not a complaint |

!!! danger "Fail-closed, on purpose"
    A rule that cannot be evaluated, whose action throws, whose script is missing, or whose script
    times out **blocks** the tool call. A YAML file that fails to parse refuses the whole session
    rather than loading with zero rules.

    This is the opposite of the guard's internal-error posture, and the asymmetry is deliberate:
    a bug in *our* guard code must not blanket-block your machine, but a declarative rule you wrote
    and that silently stops applying **is** the bug. `/doctor`'s `D-09` reports a hook layer
    sitting degraded.

!!! warning "JavaScript regex — no PCRE inline flags"
    `new RegExp('(?i)git push')` throws `Invalid group` and the rule is **dropped at load**. Use a
    bracket class on the leading letter instead: `[Gg]it\s+[Pp]ush`. The shipped `remind-worktree`
    rule carries a comment saying exactly this, because it cost somebody the discovery.

!!! warning "The `run` action fails closed too"
    A `run` rule with `match: { tool: bash }` and no script yet in place blocks **every** bash call
    — by design, since a missing script fails closed. Wire one in only once the script exists at
    the path you name. That is why no `run` rule ships enabled.

!!! tip "Why `preflight-before-remote-job` confirms instead of blocking"
    The rule cannot know whether a local run against real input already passed this session — it
    only sees the shape of the command. `block` would refuse a legitimate ninth submit along with
    the first, and get routed around within the hour; `warn` is easy to miss in a long transcript.
    `confirm` costs one keypress on a legitimate submit and reliably interrupts a repeat of the
    same failing one. It matches five command shapes on purpose, not "anything that looks remote":
    a rule that also fires on `databricks jobs list` or `kubectl get jobs` trains you to reflexively
    accept the dialog, which defeats it for the submit that matters.

Merge order: the global file loads first, then `<project>/.pi/hooks.yaml` **when the project is
trusted**. Rule ids should be unique across both. Hooks stack on the guard and may only *add*
denial, never remove it.

---

## Web

Two files that **must agree**, and a `session_start` assertion that fails loud when they do not.

Both are **generated**: `web.default.json` and `web-search.default.json` are the tracked templates,
and the installer writes the `.json` pair from your answer to one question — which single backend:

| Answer | What it costs you | What it needs |
|---|---|---|
| `searxng` | a service you host and keep running | no key, no third party |
| `tavily` / `brave` / `exa` | a hosted search API sees your queries | one API key, from a free tier you can sign up for without a card |
| `none` | no `web_search` tool at all | nothing |

Answering "none" is not a broken state; `web_search` is removed cleanly rather than left to fail at
the first call. It disables **search only** — `web_fetch` is unaffected and still needs no key,
because the package's extraction path falls back to [Jina Reader](https://r.jina.ai) (keyless) for
the JavaScript-heavy pages a plain fetch cannot read. Hand PI a URL and it still reads it.

### `web.json`

```json
{ "version": 1, "search": { "backend": "none", "answerPath": null } }
```

This repository's declared pinned backend, for humans and for `jq`-based tooling. Ships `none`;
the installer sets whichever single backend you asked for.

| Key | Ships | Notes |
|---|---|---|
| `search.backend` | `"none"` | The declared backend. **Must equal `web-search.json`'s `provider`** or the session refuses to start |
| `search.answerPath` | `null` | Path your search host serves search-read-and-cite on, joined to `searxngBaseUrl`. While it is `null` the [`web_answer`](../extensions/web.md#5-web_answer-search-that-reads-the-pages) tool is not registered at all |

!!! note "`answerPath` is not something a stock SearXNG has"
    SearXNG serves `/search`. An endpoint that searches, opens the top pages and returns a cited
    answer is a **second service you put in front of it**. Name its path here only once you run
    one; the host comes from `searxngBaseUrl` below, so there is still one address to keep
    correct.

### `web-search.json`

```json
{
  "provider": "none",
  "searxngBaseUrl": "http://127.0.0.1:8080",
  "webSearch": { "enabled": false },
  "ssrf": { "trustEnvProxy": true },
  "allowBrowserCookies": false,
  "toolNames": { "fetchContent": "web_fetch" }
}
```

This is the file the web package actually reads at runtime. It follows a **foreign schema** — it
belongs to the package, not to us — which is why the two files exist and why
`extensions/web/config-guard.ts` asserts on every `session_start` that
`web.json`'s `search.backend` equals `web-search.json`'s `provider`. A mismatch is a fail-loud
error, not silent drift.

| Key | Ships | Notes |
|---|---|---|
| `provider` | `"none"` | `searxng`, `tavily`, `brave`, `exa` or `none`. **Change it in both files or the session refuses to start** |
| `searxngBaseUrl` | `http://127.0.0.1:8080` | Your own search instance. Point it wherever yours runs. Read only while `provider` is `searxng` |
| `webSearch.enabled` | `false` | `true` alongside any real `provider`. Leaving it `false` removes `web_search` |
| `ssrf.trustEnvProxy` | `true` | Honour `HTTPS_PROXY`/`NO_PROXY` when deciding what is reachable |
| `allowBrowserCookies` | **`false`** | Do not change this casually — see below |
| `toolNames.fetchContent` | `"web_fetch"` | Renames the package's default `fetch_content`. The alias is enforced at `session_start` |

!!! note "The hosted backends' API keys are not in this file, on purpose"
    `tavily`, `brave` and `exa` authenticate with `TAVILY_API_KEY`, `BRAVE_API_KEY` and
    `EXA_API_KEY`, which the package reads **from the environment** — no entry in this file is
    needed, and none is written. The installer stores the key in `~/.pi/secrets.env` (chmod 0600),
    sourced by `config/shell/pi-env.sh`, so no secret ever lands in a tracked config file. Set the
    variable by hand and the same backend works with no installer run at all.

!!! danger "`allowBrowserCookies: true` hands your logged-in sessions to a fetch tool"
    It lets the fetcher reuse browser cookies, which means an agent following a link can retrieve
    pages as *you*, authenticated. The value of a web-fetch tool is reading public pages; the cost
    of this flag is every private page you happen to be logged into. It ships `false` and should
    stay `false` unless you have a specific, bounded reason.

!!! note "Loopback ports collide"
    `searxngBaseUrl` ships on `127.0.0.1:8080`, which is a popular port. If something else on your
    machine already owns it, move it here. The same applies to any model endpoint you configure on
    loopback through [`openai-compatible`](openai-compatible.md): its port lives in
    `config/models.json` and nowhere else, so moving it is a one-place edit.

One backend is pinned, rather than a list with fallbacks, for the same reason there is no provider
failover: a search that silently came from somewhere else is a result you cannot attribute.

---

## `pi-lsp.json`

Read by the language-server package. Adds real symbol information to the agent's reading.

```json
{
  "servers": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx"]
    },
    "python": {
      "command": ["uv", "run", "pyright-langserver", "--stdio"],
      "extensions": [".py"]
    }
  }
}
```

Add a block per language. `command` is argv, not a shell string — no quoting, no pipes. The server
must speak LSP over stdio.

**What breaks:** a `command` whose binary is not installed produces a failed server start at
session start, not a crash; the language simply gets no LSP data. That failure is quiet, so if
symbol lookups are not working, check that the binary is actually on `PATH` for a **non-login**
shell.

---

## `keybindings.json`

Ships `{}` — PI's defaults, unmodified. It exists so the symlink has a target and so you have an
obvious place to put overrides. Consult PI's own documentation for the binding names; this
repository has no opinion about them.

---

## `pi-statusline.json`

```json
{
  "segments": ["provider", "model", "thinking", "cwd", "branch", "context", "cost"],
  "extensionStatusIcons": { "quota": "📊" }
}
```

`segments` is an ordered list; drop the ones you do not want. `context` is the one worth keeping —
it is the occupancy readout, and it is how you notice a context problem before it becomes a
compaction problem.

`extensionStatusIcons` maps an extension id to the glyph it uses when it has something to say.

---

## Related

- [Safety model](../concepts/safety-model.md) — how hooks stack on the guard
- [`guard.json`](guard.md) — the rules you cannot write in `hooks.yaml`
- [bash](../extensions/bash.md), [hooks](../extensions/hooks.md), [web](../extensions/web.md),
  [big-results](../extensions/big-results.md)
