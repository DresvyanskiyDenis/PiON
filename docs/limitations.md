# Known limitations

Every entry here is something that will otherwise cost you an afternoon. Being explicit about what
does not work is a feature of this documentation, not an apology.

Everything below was measured against **PI 0.84.0 on macOS**. Some of it will change when PI does.

---

## Platform limits — things PI does not let an extension do { #platform-limits--things-pi-does-not-let-an-extension-do }

### An extension cannot abort a headless run

Inside a pre-compaction handler under `pi -p`, `ctx.shutdown()` and `ctx.abort()` both return
`undefined` and do nothing. `ctx.signal` stays `undefined`, `isIdle()` stays `false`, and the session
runs on and exits **0**. `{ cancel: true }` stops the compaction but still exits 0 with no output.
The only working exit is `process.exit()` from inside the handler, which is immediate — PI's own
teardown never fires and no other extension gets to clean up.

**Consequence:** [`bin/pi-run`](operations/cli.md#pi-run) exists, and you should never use bare
`pi -p` unattended.

### `pi -p --mode json` exits 0 on a failed turn

A scheduled job checking `$?` cannot tell success from failure. Same consequence, same fix.

### A `resources_discover` handler can only ADD skills

`extendResources` performs a **union** with what the settings-driven scan already found. No path in
that chain removes a root, so there is no such thing as a skill mask. See
[skill-mask](extensions/skill-mask.md).

### Contributed skill roots lose every name collision

Contributed roots are **appended**, and `loadSkills` keeps the *first* loader of each name. Anything
settings-driven is resolved first and rank-ordered above them. **Name your skill roots in
`config/settings.json`** or your skills will be silently shadowed — measured, not theorised.

### `allowed-tools` in skill frontmatter does nothing

PI's frontmatter reader parses exactly three fields: `name`, `description`,
`disable-model-invocation`. `allowed-tools` is read by nothing, anywhere.
[`skills-lint`](extensions/skills-lint.md) warns; it cannot enforce. If you need a real tool
restriction, use a [sub-agent](extending/subagents.md), whose `tools:` list *is* honoured.

### `baseUrl` is not variable-expanded

`$VAR` and `!command` work for `apiKey` and `headers` only. A host that varies per installation is
substituted at install time. See [`models.json`](configuration/models.md#baseurl).

### `!command` credentials have no TTL

Re-executed on **every** request. Wrap anything expensive in a TTL cache.

### There are no timeout fields in PI's provider schema

A cold start that pages tens of GB of weights — a model server on your own hardware, typically — can
exceed the default HTTP timeout, and there is no field to raise it. An extension used to work around
this for a dedicated local lane with its own abort budget; that lane was deleted on 2026-08-15, so
the limitation is now unmitigated and shows up as a timeout on the first request after a cold
start.

### The standalone `pi` binary ignores `NODE_OPTIONS`

An invalid value is silently ignored where a real `node` CLI refuses to start. Proxy support is
implemented directly in [`web`](extensions/web.md) instead.

### The event bus has no replay buffer

A listener attached after an `emit()` receives nothing, ever. Anything ordering-sensitive must gate
on recorded state, not on an event. See [`doctor`](extensions/doctor.md)'s `D-06`.

### The `pi` binary is a compiled Bun executable, not Node — some declared packages fail to load under it

`pi` (`file` reports Mach-O with a `__BUN` section, `bun --version` on this machine is 1.3.11) uses
Bun's own module resolver for every entry in `settings.packages`, not the system `node` these packages
were written against. Each of the packages below was reviewed, pinned and present in `node_modules`
when it was tested — but wiring it into `settings.packages` and starting a real session (`pi -p '...'`,
not `pi --list-models`, which does not exercise extension registration) throws and **aborts startup
entirely**, one failed extension being enough to abort all of them:

| Package | Failure, verbatim | Category |
|---|---|---|
| `pi-hashline-edit-pro`, `@nklisch/pi-plugins` | `ResolveMessage: No such built-in module: node:sqlite` | Bun does not implement Node's `node:sqlite` (it ships `bun:sqlite` instead); both packages assume Node ≥22.5's built-in. |
| `@99percentpeople/pi-background-tasks` | `ResolveMessage: Cannot find module '@xterm/headless'` | The dependency is physically present in `node_modules`; Bun's resolver still cannot find it — unexplained, not chased further. |
| `pi-smart-compact` | `ResolveMessage: NameTooLong while resolving package 'data:text/javascript;base64,...'` | A jiti-style in-memory TS transpile handed to Bun's resolver as a `data:` URL; Bun appears to cap resolvable module specifier length below what a bundled file encodes to. |
| `pi-opa-net` | `Failed to load extension: undefined is not an object (evaluating '_index.default')` | The package's `src/pi/index.ts` calls its registration function eagerly at module scope but does not `export default` it — a packaging bug, not a config problem. |
| `pi-web-search` | `Tool "web_search" conflicts with .../pi-web-access/index.ts` | `pi-web-search` and the already-adopted `pi-web-access` both default to a tool named `web_search`; PI's loader rejects the duplicate registration outright. Wiring both together is not possible without one of them renaming its tool. |

None of this is visible from `pi --list-models` — that command loads packages but does not appear to
exercise the same registration path a real session does, so it is not a substitute for a real
`pi -p '...'` smoke call when validating a newly wired package. `settings.default.json` in this
repository therefore ships only the four packages from this review that load cleanly under a real
session start (`@narumitw/pi-usage`, `pi-lean-ctx`, `pi-hermes-memory`, `pi-sandbox`, alongside the
packages already adopted before this review).

All five packages in the table were **uninstalled on 2026-08-29**. None was ever in
`settings.default.json`'s `packages[]`, precisely because wiring any one of them breaks every session
— and a package that cannot be wired earns nothing by being carried in `package.json` and
redistributed. The failures stay recorded here because they are the reason not to re-adopt any of
them without re-testing against the pinned `pi`; the per-package reasons are in the
[package ledger](PACKAGES.md) and in `config/packages.lock.json`'s `not_installed[]`.

### An interactive dialog cannot tell you *why* it got no answer

`ctx.ui.select` and `ctx.ui.input` resolve `undefined` on a dismissal, on an aborted `AbortSignal`,
and on `ExtensionUIDialogOptions.timeout` alike — one `defaultValue` for all three, in the same
`createDialogPromise` (`modes/rpc/rpc-mode.js:47-69`). Nothing throws, so the three causes arrive
indistinguishable.

**Consequence:** an extension that needs to know which one happened has to record it *before* it
aborts, not read it afterwards. A flag set ahead of `signal.abort()` is the only thing at that call
site that carries a reason.

### `pi-subagents`' supervisor channel bounds the request and not the reply

A child's `contact_supervisor` request is size-checked against `MAX_MESSAGE_BYTES` (64 KiB) at
`intercom/native-supervisor-channel.ts:264`. The reply travelling the other way is not: `writeReply`
(`:541-551`) rejects an empty or whitespace-only message and checks nothing else.

**Consequence:** an empty reply fails loudly with no help from you; an oversized one does not fail at
all. Anything composing a reply owns its own size bound, and 64 KiB is not the number to copy — that
one bounds a machine-composed request, not whatever the reply path is fed.

### An extension cannot make a tool it does not own run sequentially

`executeToolCallsParallel` is the default (`agent-loop.js:290-294`); the loop serializes a batch only
when `config.toolExecution === "sequential"` or when some tool **in that batch** declares
`executionMode: "sequential"`. That flag lives on the tool definition, so it is available for a tool
you register and unavailable for one shipped by a package.

Concurrency of that kind is not exotic. `sendCustomMessage` (`core/agent-session.js:1081-1088`)
*steers* a custom message arriving mid-stream into the **running** turn rather than queueing it for a
later one, so two independently-arriving requests routinely land in a single assistant message.

**Consequence:** if you are wrapping a package-owned tool in a `tool_call` handler and that handler
must not run twice at once, the mutex is yours to write. The agent loop does not provide one and
cannot be asked to.

---

## Design limits — deliberate non-goals

### Egress classes are not a network boundary, and no longer refuse anything

Nothing intercepts a socket. A class is a word in `routing.json`, printed beside every provider,
model and agent so a human or a model can see where a prompt is about to go. Repeated in three
places in these docs because the word invites the wrong assumption.

Until 2026-08-13 they at least refused a **dispatch**: a session could not send a child to a
provider classed looser than itself. That rule was withdrawn — it refused ordinary work far more
often than it prevented anything, and it never made the network claim true.
[ADR 0004](adr/0004-egress-classes-are-declarative.md).

### `path-defaults`' per-channel policy is declarative only

It computes and exports `{web, mcp, publicModels}` — one policy for the whole install, since
2026-08-15 — for other modules to honour at their own call sites. An install with no such wiring
enforces nothing from that channel.

### There is no provider failover, and there will not be

`onProviderError` is `{"policy": "abort", "substituteProvider": false}`. A failover extension was
specified, scheduled and **cancelled**. See
[the reasoning](configuration/routing.md#onprovidererror).

`@narumitw/pi-retry` was removed from this ledger 2026-08-15 for the same reason: its actual job —
widening PI's built-in transient-retry classifier and a stall-watchdog abort — never substitutes a
provider or a model, but a retry package sitting in a harness whose standing rule is "abort loud on
the first real failure" is exactly the kind of surface that can end up papering over the failure this
project exists to surface. Removed rather than kept-but-unwired.

### `reserveTokens` is global

One number for every model in the tree. It cannot be used as a per-model compaction threshold, and
attempting it breaks providers. The per-model lever is `modelOverrides.<id>.contextWindow`. See
[Context windows](concepts/context-windows.md).

### The guard is not a sandbox

**There is no OS-level sandbox around bash.** Nothing here confines a command's writes to the working
directory at the operating-system layer, and nothing is auto-approved for being sandboxed, because
nothing is sandboxed. `pi-sandbox` is the mechanism that would do it and it is **not wired**; the
reasons it was not adopted are in
[Safety model](concepts/safety-model.md#why-it-does-not-delegate-to-a-sandbox). Read the four points
below before you decide what to run this against.

- **The write boundary exists at the guard layer only, and since 2026-08-14 it cannot even refuse.**
  The `FS-*` gate *records* a bash command whose write targets resolve outside the working directory
  and the session temp dir — it no longer blocks one. It reads the command as text. It is a static
  check, not an OS boundary, and it is audit-only.
- **Interpreter-internal writes are invisible to it.** `python3 -c`, `node -e`,
  `awk '{print > "…"}'`, a `make` target, a `$( )` subshell — the destination is expressed inside a
  program's own argument text and no static analysis can follow it. These are not edge cases; they
  are ordinary commands an agent issues all day.
- **Every program runs with neither a prompt nor an OS sandbox.** There is no allowlist any more —
  by owner decision, 2026-08-14, the allow-list model was removed outright. `sed`, `tar`, `unzip`,
  `awk`, `python3`, `node`, `make`, `docker`, `sh`, `xargs`, `ssh`, `sudo`, `curl` — every one of them
  executes unattended, headless included, with no prompt and no per-program decision anywhere in the
  guard. The only bound on what any of them can do is the small set of catastrophic command shapes
  described below, plus (for writes specifically) the now-audit-only `FS-*` record.

The guard also does not contain a process that already started. See
[Safety model](concepts/safety-model.md#what-this-does-not-protect-you-from).

What still stops a headless run, with no config and no override: `DB-*` (eight catastrophic shapes —
`rm -rf /`, fork bomb, `dd of=/dev/…`, `mkfs`, redirect onto a raw disk, `chmod -R 777 /`,
`curl … | sh`, shutdown), and two `GIT-*` rules (`GIT-REWRITE`, `GIT-FORCE-PROTECTED`). `SEC-*`
(credential paths) was on that list until 2026-08-15 and is now audit-only: a credential read is
recorded and permitted, and its contents reach the provider serving the next turn — see
[Safety model](concepts/safety-model.md#credential-reads-are-no-longer-refused). Nothing else in the guard can refuse a bash command, and
nothing prompts — a UI present or absent makes no difference. `PI_GUARD_APPROVE` and
`PI_GUARD_SESSION_ALLOWLIST` are removed rather than left inert; if you see either name anywhere in
an older note, it is stale.

### Task lists do not survive a session

The task package replays state from the session transcript and writes nothing to disk. If a plan must
outlive a session, write it to a file. See [tasks](extensions/tasks.md).

### `hooks.yaml` is deliberately not expressive

Five fields, plus `run`. Requests for a sixth should become a sub-agent or a guard gate. A hook
language is a programming language nobody wanted to write.

---

## Prompt-cache limits — what moves the cached prefix { #prompt-cache-limits--what-moves-the-cached-prefix }

A provider caches a **prefix**. Everything from the first byte up to the first byte that differs
from last time is a cache read; everything after it is a cache write. So a request has two zones,
and every piece of text this repository contributes belongs to exactly one of them:

- **The prefix zone** — tool schemas, the system prompt, and the conversation up to the last
  message. Text here has to be **byte-identical from turn to turn**. A block whose content changes
  mid-session does not merely cost its own size, it costs *everything behind it*.
- **The tail** — appended after the last real message, through the `context` event. Text here may
  change on every single call and costs only itself.

Volatile content belongs at the tail. That is the whole rule.
[`path-rules`](extensions/path-rules.md) is the worked example: its rule set grows as the session
touches new files, so it is rendered into the tail before every LLM call rather than into the
system prompt, where each newly activated rule would have re-written the whole conversation behind
it at cache-write rates.

### What the harness already fixes — do not imitate it

**Extension system-prompt edits do not accumulate.** PI hands `before_agent_start` its *base*
system prompt every turn and keeps the result for that turn only. The order of the blocks
extensions append is the registration order in `extensions/index.ts`, identical on every turn, and
a module that appends without stripping its own previous block still does not double.

**`context` runs before every provider request** — not once per turn. Once per LLM call, including
mid-turn calls after a tool result and the first call after a compaction, `/reload` or fork. There
is no case where a `before_agent_start` injection is seen and a `context` injection is not, which
is why `path-rules` needs no second, "durable" delivery path.

### What is stable, and what is a deliberate trade

[`dispatch`](extensions/dispatch.md)'s model menu is computed once at `session_start` and injected
byte-identically thereafter. Nothing in this tree renders a clock —
[`session-context`](extensions/session-context.md) renders a *date*, and a message's `timestamp` is
harness metadata that never reaches the provider.

Two things do move the prefix, and both are trades rather than defects:

- **[`tool-masks`](extensions/tool-masks.md) moves the tool roster.** The schemas sit ahead of
  everything, so each mask application and each release is a full-context rebuild — and a turn mask
  applies and releases inside one turn, so it costs two. There is no way to make a capability
  physically absent without changing the roster. Spend it knowingly: a session alternating between
  two rosters shows cacheRead alternating between two values, which is the signature.
- **`session-context`'s block changes at local midnight and on `/model`.** Correctness wins: a
  block asserting yesterday's date, or a model the session no longer runs, is worse than one
  rebuild.

### Retention is not a knob you have here

`PI_CACHE_RETENTION=long` only reaches the wire as `prompt_cache_retention` when the provider also
declares `supportsLongCacheRetention`, and no provider template in this repository declares it —
`cacheControlFormat` is deliberately unset on every gateway-shaped provider, because a proxy in the
path does not reliably surface `cache_control` breakpoints and declaring it would report savings
that did not happen ([`models.json`](configuration/models.md), [LiteLLM](configuration/litellm.md)).
On those routes no breakpoint is sent at all: the endpoint does automatic prefix caching, matching
greedily from the first byte, with no API surface. A full miss after a long idle is that automatic
cache being evicted, and nothing in this repository or in your environment extends its TTL. The
variable is still correct for a direct route that *does* declare the flag; leave it set.

### Measuring it

[`session-index`](extensions/session-index.md) already records `tokens_cache_read` and
`tokens_cache_write` per session, so prefix stability is observable without adding anything:

```bash
bin/pi-log cache
```

Read the `reuse` column (cacheRead / cacheWrite). **Healthy**: it climbs with turn count and is
comfortably above 1 by turn ten — a stable prefix means each turn re-reads the conversation from
cache and writes only the new tail. **Broken**: at or below ~0.5 over a long session, with `w/turn`
near whole-context size rather than near one turn's worth of new text.

This is a smell test, not a proof. It aggregates a whole session, so it cannot say *which* turn
diverged — a session that legitimately switched model or crossed midnight scores like a broken one.
To localise a suspect block, read the per-turn `usage.cacheRead` out of the session JSONL: a
cacheRead that stays constant across turns instead of growing is the signature, and the constant is
roughly how many tokens sit ahead of the first byte that changes.

The free half of the regression check is static, and worth copying: assert that no module
contributing to the prefix returns a `systemPrompt` from `before_agent_start` unless its content is
session-stable. `test/path-rules/index.test.ts` does exactly that — it asserts the handler count is
zero and puts the reason in the assertion message.

---

## Not ported — capabilities that exist elsewhere and not here { #not-ported--capabilities-that-exist-elsewhere-and-not-here }

### Browser-connector integrations

A connector bound to a specific vendor's account, driving a browser the vendor controls, has no
equivalent here and cannot have one. There is no API surface to port against.

Likewise, hosted-assistant "connectors" that live inside a vendor's own web product are not
reachable from a local harness.

### Personal memory servers

Out of scope by design. This repository ships **no MCP server definitions** and no personal
knowledge store. The [mechanisms](extending/mcp-servers.md) for adding your own are first-class;
the content is yours.

### One context-optimisation package, rejected on two counts

A well-regarded token-optimiser was reviewed and **not adopted**: its licence is non-commercial, and
its design depends on four PI events that do not exist. The second reason would have been enough on
its own.

Its concept partly survives in [`big-results`](extensions/big-results.md) — but as a *handle* rather
than a *shrink*, because shrinking is lossy and irreversible while a handle is neither.

### A community hard fork was avoided

A Rust fork of PI's core offers path-scoped model selection. Only the *shape* of the idea was ported
— into [`path-defaults`](extensions/path-defaults.md) — because adopting the fork would mean
tracking a divergent core engine forever, for one feature.

### Custom slash commands

PI has prompt templates and `/skill:<name>`. The mapping is direct; the syntax is not identical.
Nothing is lost, but nothing ports byte-for-byte either.

---

## Things that are just missing

- **No skill is loaded by default.** The discovery mechanism, the precedence ranks, the lint and the
  env shim all ship; the loaded roster is empty. One worked example is tracked under
  `examples/skills/`, outside every search path, and
  [adding your own](extending/skills.md) is a documented first-class path.
- **No MCP servers ship.** Same reasoning, same answer:
  [add your own](extending/mcp-servers.md).
- **`keybindings.json` is empty.** PI's defaults, unmodified.
- **Tested on macOS.** Nothing here is knowingly macOS-only apart from the keychain example, but
  Linux is untested and Windows is not considered.

---

## Related

- [Safety model](concepts/safety-model.md) — what is and is not enforced
- [Context windows](concepts/context-windows.md) — the one rule that matters most
- [Troubleshooting](operations/troubleshooting.md) — what to do when one of these bites
- [Architecture decisions](adr/index.md) — the four that produced most of the limitations above
