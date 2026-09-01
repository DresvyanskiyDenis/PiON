# `config/settings.json` — PI's own behaviour

**Generated, not tracked.** `config/settings.default.json` is the template in git; the installer
copies it to `config/settings.json` and patches your answers in. The generated file is the one that
runs, is git-ignored, and is symlinked as `~/.pi/agent/settings.json` — the same bytes.

Edit `config/settings.json` freely; a re-run patches it rather than resetting it, so your edit
survives. An edit that must also survive a **fresh clone** goes in `config/settings.default.json`.
Every "Ships" value below is that template's value.

This is the only file in `config/` that PI itself fully owns. Every key below is a PI setting, not
one of ours — which means the honest answer to "is this the complete list?" is *no*: PI accepts
more keys than this file sets. The ones documented here are the ones this harness ships an opinion
about.

A per-project `.pi/settings.json` is deep-merged **over** this file, but only after the project is
trusted. See [Paths and trust](paths-and-trust.md#per-project-settings).

Plain JSON. **PI will not parse comments** — no JSON5, no trailing commas. All commentary lives in
these docs.

---

## Model and thinking

| Key | Ships | What it does |
|---|---|---|
| `defaultProvider` | `"github-copilot"` | Provider for the main interactive session |
| `defaultModel` | `"claude-opus-5"` | Model id **within** that provider — not provider-qualified here |
| `defaultThinkingLevel` | `"medium"` | `minimal` \| `low` \| `medium` \| `high` |

The main session's default *is* the `strong` tier in practice; tiers are not exposed in the TUI
model picker because there would be nothing for them to add. Change the model for a single session
with `/model` or ++ctrl+p++, or per invocation with `--model '<provider>/<id>'`.

**What breaks:** `defaultModel` naming an id the provider does not serve leaves you unable to start
a turn. `defaultProvider` naming a provider absent from `models.json` is worse — nothing resolves.
Run `pi-check --all` after changing either.

### `thinkingBudgets`

```json
"thinkingBudgets": { "minimal": 2048, "low": 6144, "medium": 12288, "high": 24576 }
```

Token budget per thinking level. `routing.json`'s per-tier `thinkingLevel` selects among these.

**What breaks:** raising `high` past what the model supports is rejected by the provider. More
subtly, near the compaction threshold PI clamps a request's `max_tokens` to
`contextWindow − context − 4096`, so a large budget is silently squeezed — at ~180 000 of context
against a 200 000 window it lands near 16 900, below the 24 576 configured here. That is expected
and self-limiting; see [Context windows](../concepts/context-windows.md#the-200-000-cap-and-what-it-costs).

| Key | Ships | Alternative |
|---|---|---|
| `hideThinkingBlock` | `false` | `true` if you find the thinking stream noisy. You lose the main signal for *why* a wrong turn went wrong |
| `showCacheMissNotices` | `true` | `false` to quieten the TUI. Keep it on while tuning a provider — a cache miss you did not expect usually means the prompt prefix churned |
| `warnings.anthropicExtraUsage` | `true` | `false` to suppress the extra-usage warning |

---

## Trust

| Key | Ships | What it does |
|---|---|---|
| `defaultProjectTrust` | `"ask"` | What PI does when it first meets a project directory: `ask` \| `always` \| `never` |

!!! danger "`defaultProjectTrust` must stay `\"ask\"`"
    No `bin/pi-check` rule enforces this value — it is a decision you can undo, and that is
    decoration. Setting it to `"always"` globally disables the gate that stops a freshly cloned
    repository executing its own TypeScript extensions, loading its own hooks, and — via the
    vendored MCP adapter — spawning its own MCP servers on your machine with your environment.

    If you want a *specific* directory tree auto-trusted, that is what
    [`config/trusted-roots.json`](paths-and-trust.md) is for. It answers "yes" inside roots you
    named and "undecided" everywhere else, so PI's own prompt still runs for everything you did not
    think about. Narrow beats broad.

---

## Compaction

```json
"compaction": { "enabled": true, "reserveTokens": 20000, "keepRecentTokens": 20000 }
```

`CompactionSettings` has **exactly** these three keys. There is no absolute-threshold key here, and
that constraint drives a lot of this project's design.

| Key | Ships | What it does |
|---|---|---|
| `enabled` | `true` | Turn compaction off entirely and a long session simply dies at the provider's limit. Only sensible for a short scripted run |
| `reserveTokens` | `20000` | The trigger is `contextTokens > contextWindow − reserveTokens`. **Global — one number for every model in the tree** |
| `keepRecentTokens` | `20000` | How much recent dialogue survives a compaction verbatim |

!!! danger "`reserveTokens` is not a per-model threshold, and using it as one breaks providers"
    Suppose you want compaction at 180 000 on a model whose catalogue claims 1 000 000. Through
    `reserveTokens` that needs `820000`. Apply the same global scalar to a 200 000-token model and
    `200000 − 820000` is **negative** — `shouldCompact` is true for any context at all, compaction
    fires every turn, its reduction falls under the loop guard's `minReductionRatio`, and after
    three non-reducing passes the run aborts.

    **The right lever is `providers.<p>.modelOverrides.<id>.contextWindow`** in
    [`models.json`](models.md#modeloverrides). Read
    [Context windows](../concepts/context-windows.md) before touching either number.

`keepRecentTokens` is worth understanding for a different reason: `prepareCompaction()` never looks
at the context window. It walks entries backwards accumulating tokens until it reaches
`keepRecentTokens`, and if the whole *dialogue* is smaller than that, the set to summarise comes out
empty and you get **"Nothing to compact (session too small)"** on a session that is visibly not
small. The preamble — system prompt, tool schemas, skill catalogue — is excluded twice over: it is
not a session entry, and it is rebuilt every request, so compaction could not shrink it in
principle. `/context` is what tells the two apart.

Raise `keepRecentTokens` when the agent keeps forgetting the last few steps after a compaction;
lower it when compactions are not reclaiming enough to matter.

### `branchSummary`

```json
"branchSummary": { "reserveTokens": 16384, "skipPrompt": false }
```

The separate budget for branch summarisation. `skipPrompt: true` stops it asking. Note that some
provider integrations resolve their endpoint differently on the compaction and branch-summary paths
than on the main chat path — a provider that answers a normal turn can still fail the moment
compaction fires, which is why [first run](../getting-started/first-run.md) tells you to run
`/compact` once per provider.

---

## Retry and transport

```json
"retry": {
  "enabled": true, "maxRetries": 3, "baseDelayMs": 2000,
  "provider": { "maxRetries": 0, "maxRetryDelayMs": 60000 }
}
```

| Key | Ships | What it does |
|---|---|---|
| `retry.maxRetries` | `3` | Retries for transient transport failures |
| `retry.baseDelayMs` | `2000` | Backoff base |
| `retry.provider.maxRetries` | **`0`** | Retries for a **provider-level** error |
| `retry.provider.maxRetryDelayMs` | `60000` | Cap on that backoff, when it is non-zero |

!!! note "`retry.provider.maxRetries: 0` is deliberate and belongs to the fail-loud rule"
    A provider error — auth, quota, policy, model-not-found — is almost never transient, and
    retrying it three times turns a two-second diagnosis into a two-minute one while burning
    quota. Raise it only if your provider genuinely returns 5xx under load and you would rather
    wait than see the abort.

| Key | Ships | What it does |
|---|---|---|
| `transport` | `"auto"` | `auto` \| `http` \| `websocket` |
| `httpIdleTimeoutMs` | `300000` | Five minutes of idle before the HTTP connection is dropped. Raise it if you drive very long single turns through a slow gateway |
| `websocketConnectTimeoutMs` | `15000` | |

---

## Resource paths

These five arrays are how PI finds everything this repository adds.

```json
"skills":     ["~/.pi/agent/skills"],
"prompts":    ["~/.pi/agent/prompts"],
"extensions": ["~/pi-config/extensions/index.ts"],
"themes":     ["~/pi-config/themes"],
"packages":   [
  "~/pi-config/pi-packages/pi-mcp-adapter",
  "~/pi-config/node_modules/pi-subagents",
  "~/pi-config/node_modules/pi-web-access",
  "~/pi-config/node_modules/@juicesharp/rpiv-todo",
  "~/pi-config/node_modules/@mrclrchtr/supi-bash-timeout",
  "~/pi-config/node_modules/@narumitw/pi-statusline",
  "~/pi-config/node_modules/@narumitw/pi-worktree",
  "~/pi-config/node_modules/@narumitw/pi-lsp"
]
```

!!! warning "`extensions` names exactly one file, on purpose"
    `extensions/index.ts` is a composition root that imports and registers 38 modules in a fixed
    order. Pointing PI at the *directory* instead would load each of them as a separate extension in
    `readdir` order, fail every one that has no default export, and let `readdir` decide the `tool_call`
    chaining order — which decides whether `guard` sees a call before `bash` rewrites it. Do not
    "simplify" this line. [Architecture](../concepts/architecture.md) has the full argument.

`skills` is the array you extend to add your own skills. **Nothing on this path ships populated** —
the loading mechanism ships, the content does not, and the one worked example under
`examples/skills/` is deliberately outside every search path. The one entry is where the
installer symlinks the clone's git-ignored `skills/`, so the directory you write into and the path
PI searches are the same directory under two names; PI tolerates it being absent.

!!! note "One root, declared once"
    An earlier layout split user skills across three sibling directories. That split looked like a
    privacy boundary and was not one: a single `.gitignore` line was doing the whole job, and two of
    the three roots were never in this array at all — an extension contributed them at runtime, and
    PI merges contributed roots **last**, so every skill in them silently lost a name collision to
    `~/.agents/skills`. Adding a root here is the only way to make one win. One root, declared in
    the array, is the honest shape.

See [Writing a skill](../extending/skills.md) for the precedence ranks and a worked example.

`packages` is a list of directories, one per adopted community package. `pi-mcp-adapter` points at
`pi-packages/` rather than `node_modules/` because it is **vendored in-tree and locally patched** —
see [Safety model](../concepts/safety-model.md#why-some-code-is-in-tree) and
[Third-party components](../reference/third-party.md).

**What breaks:** removing a `packages` entry removes its tools without removing the config that
references them; `/doctor`'s `D-08` will tell you, as a warning. Adding a package here without
adding it to `config/packages.lock.json` breaks `bin/pi-check`'s `PC-09` / `PC-18` / `PC-19`
three-way agreement check.

| Key | Ships | What it does |
|---|---|---|
| `enableSkillCommands` | `true` | Exposes each discovered skill as `/skill:<name>` |
| `lastChangelogVersion` | `"0.84.0"` | PI's own bookkeeping. Not a knob |

---

## Interface

None of these change behaviour that matters. They are here so you know they exist and stop looking
for them elsewhere.

| Key | Ships | Notes |
|---|---|---|
| `theme` | `"Tokyo Night"` | Selects by the `name` inside a theme file, not by filename. See [Themes](themes.md) |
| `tuiMode` | `"regular"` | |
| `quietStartup` | `false` | `true` suppresses the banner |
| `externalEditor` | `"code --wait"` | **Must block until the editor exits.** A non-blocking command returns an empty buffer instantly, which looks like the editor failing to open. `vim`, `nano`, `"code --wait"`, `"subl -w"` are fine |
| `doubleEscapeAction` | `"tree"` | What double-++escape++ does |
| `treeFilterMode` | `"default"` | |
| `collapseChangelog` | `true` | |
| `autocompleteMaxVisible` | `8` | |
| `steeringMode` | `"all"` | How queued steering messages are delivered — see below, the one exception in this table |
| `followUpMode` | `"one-at-a-time"` | |
| `terminal.showImages` | `true` | |
| `terminal.imageWidthCells` | `60` | |
| `terminal.showTerminalProgress` | `true` | |
| `images.autoResize` | `true` | |
| `images.blockImages` | `false` | `true` refuses images entirely |
| `markdown.codeBlockIndent` | `"  "` | |
| `markdown.mermaid` | `"streaming"` | |

`steeringMode` is the one key here whose value is a deliberate trade, not a cosmetic. A message
typed while the model is streaming is queued; `"all"` hands over the whole queue at the next
opportunity, so two or three corrections typed in a row reach the model together instead of it
acting on the first while the rest wait a turn or more. The cost is delivery determinism — `"all"`
reorders steering messages relative to tool results. `followUpMode` stays `"one-at-a-time"` and
keeps that guarantee for follow-ups, which is why the two keys ship different values.

---

## `subagents.watchdog` — the key PI carries but never reads { #subagentswatchdog }

```json
"subagents": {
  "watchdog": {
    "enabled": true,
    "main": { "enabled": false },
    "children": { "enabled": true },
    "asyncCompletion": { "enabled": true, "autoFollowBlockers": true }
  }
}
```

This block is not PI's. `pi-subagents` reads its watchdog configuration out of the **agent settings
file** — `watchdog/settings.ts` resolves `getAgentDir()/settings.json` and then looks at exactly
`settings.subagents.watchdog`. It is not read from [`config/subagent.json`](dispatch.md), which
feeds a different reader; a `watchdog` key there is silently ignored. PI's own loader passes the
unknown `subagents` key through a load/save round trip untouched, so this file is the only place
the setting can go.

It is validated **strictly**. An unknown field throws, and the package then degrades the whole file
to its own defaults — which are off. A typo here is not an ignored key, it is a watchdog that
quietly does nothing.

| Key | Ships | Why |
|---|---|---|
| `enabled` | `true` | A prerequisite, not decoration: the child flag is ANDed with this one, so `children.enabled` alone resolves to nothing |
| `main.enabled` | `false` | Said out loud because it is otherwise **derived** from `enabled`. Left implicit, watching children would also buy a review model call at every `agent_end` of the lead. The lead endpoint is its own decision |
| `children.enabled` | `true` | A writer child's `agent_end` gets reviewed. `children.model` stays unset on purpose — the review then runs on the child's own session model, so no bare model id enters a config file (`PC-08`) |
| `asyncCompletion.enabled` | `true` | An async child that comes back **empty** is followed up automatically instead of by a manual, full-price `subagent resume`. Upstream still reads this nowhere; the harness does — [`extensions/dispatch/async-resume.ts`](../extensions/dispatch.md#an-async-child-that-came-back-empty-gets-one-follow-up), gated on this key AND `enabled` |
| `asyncCompletion.autoFollowBlockers` | `true` | A **blocked** async child — one that came back with a question or a stated obstacle — is the watchdog's own follow-up cycle. Read and reported by the harness, gating nothing there: it is a different recovery, with a different message and a different budget |

`autoFollow.blockers` and `autoFollow.maxAttempts: 3` are already the package's defaults and are
deliberately not restated. `test/dispatch/watchdog-settings.test.ts` pins them, so a default that
flips upstream is loud rather than silent.

### Two things this block cannot say to `pi-subagents`, and what stands in for them

**`asyncCompletion` is parsed by `pi-subagents` and consumed by nothing *there* — so the harness
consumes it.** In the pinned package the string still occurs in exactly two files, the parser and
the type, and no runtime reads it; `test/dispatch/watchdog-settings.test.ts` asserts that file list
and fails the moment upstream wires it up.

What changed is which side answers. The key now has a first-party consumer,
[`extensions/dispatch/async-resume.ts`](../extensions/dispatch.md#an-async-child-that-came-back-empty-gets-one-follow-up):
when the dispatch extension's `turn_end` sweep reconciles an async run whose terminal error carries
the runner's own `Subagent produced no output …`, it sends exactly one `resume` over the package's
in-process RPC. It is gated on `watchdog.enabled` AND `asyncCompletion.enabled`, both read from this
file and both required to be literally `true` — the same AND the package applies to its own endpoint
flags, and both ship OFF upstream, so a tree that never asked for this never gets it. The budget is
one attempt per run, written to `~/.local/state/pi-config/dispatch/async-resume.jsonl` before the
request goes out and re-read from disk on every sweep, so it holds across a restart; the run a
successful resume starts inherits a spent budget, which is what makes a chain of empty children
impossible rather than merely unlikely. `autoFollowBlockers` is read and reported and gates nothing
here: a blocked child is a different recovery, and it is still the watchdog's.

So the block above is no longer inert, and the setting no longer waits on upstream for the case it
names most concretely. What it still cannot do is reach the package's own watchdog runtime — an
async completion is *reviewed* by nobody until that lands.

**`subagent_wait`'s `stopOnAttention` default is code, not config — so the harness sets it on the
call instead.** The tool resolves it as
`params.stopOnAttention ?? deps.stopOnAttention !== false`, and the only injector of that dep is
the package's internal auto-drain, which passes `false`; the wait tool's whole config surface is one
boolean. So no key anywhere makes a blocking wait ignore attention pings by default, and patching
`node_modules` would be inert — the installed tree is what runs, and
[`PC-21`](../operations/verification.md) keeps it unmodified.

What the harness does instead: [`extensions/dispatch/wait-attention.ts`](../extensions/dispatch.md#a-blocking-wait-does-not-wake-on-heartbeats)
writes `stopOnAttention: false` onto a blocking `subagent_wait` that did not name it, from the
`DSP-WAIT` `tool_call` rule — the same in-place argument rewrite `clampConcurrency` uses, and the
one mechanism this repo has for a default the package will not take from config. The knobs are
`waitTools` and `waitStopOnAttention` in [`config/dispatch.json`](dispatch.md); setting the latter to
`true` restores the package default by writing nothing at all.

**The semantics, stated once.** A wait still returns on every terminal state
(complete/failed/paused), on the timeout, and on a child's `contact_supervisor`/intercom request:
`isDone()` reads `stopOnAttention || hasSupervisorTool(run)`, so the genuine ask is checked
independently of the flag. What stops waking the lead is the two heuristics: idle beyond 60 s
(scaled ×2/×5/×10 for medium/high/xhigh thinking) and one tool call open for 240 s or more. Neither
is a question, and each spurious wake cost a full re-read of the lead's context. A call that wants
the old behaviour passes `stopOnAttention: true` and always wins; a `nonBlocking: true` subscription
is left untouched, because the flag cannot reach that branch. The first rewritten wait in a session
announces the changed default once, since the package's own tool description still advertises the
opposite.

---

## Telemetry

```json
"enableInstallTelemetry": false,
"enableAnalytics": false
```

Both off. [`config/shell/pi-env.sh`](environment.md) also exports `PI_TELEMETRY=0` and
`PI_SKIP_VERSION_CHECK=1`, so the posture holds for processes that never read this file. Turning
them on is your call; this repository ships them off and does not phone anywhere itself.

---

## Verifying a change

```bash
bin/pi-check --all   # every rule that does not need the network
```

then start a session and run `/doctor`.

## Related

- [Context windows](../concepts/context-windows.md) — before touching `compaction`
- [Paths and trust](paths-and-trust.md) — before touching `defaultProjectTrust`
- [Adding a skill](../extending/skills.md) — before touching `skills`
- [`dispatch.json` and `agents/`](dispatch.md) — the sub-agents `subagents.watchdog` watches
