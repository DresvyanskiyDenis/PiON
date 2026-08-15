# Troubleshooting

Symptom first. Every entry names the check that confirms it and the page that fixes it.

**Start here, always:**

```text
/doctor
```

Nine checks, and most of what follows shows up in one of them.

---

## Startup and loading

### The agent refuses `bash`, `write`, `edit`, `read` and `grep` — everything

That is the **deadman**, and it is deliberate. A guardrail module failed to load, so
[`trust`](../extensions/trust.md) blocked the dangerous tools rather than letting the session run
unguarded.

```text
/doctor      # D-05 names the module, D-06 says whether the guard is alive
```

`D-05` distinguishes two cases with the same severity and different fixes:

- the module **threw during `register()`** → read the stack trace;
- the module **was never tried** → its static import failed before any code ran; check the import
  graph.

An agent that refuses to work is a bug report. An agent that works without its guardrails is an
incident.

### Nothing loaded at all — no commands, no tools

Check that `config/settings.json`'s `extensions` array names **one file**, the composition root, and
that `~/.pi/agent/extensions` is **not** a symlink to the `extensions/` directory.

```bash
ls -l ~/.pi/agent/extensions        # should not exist as a link to extensions/
./scripts/postinstall-verify.sh     # the "extensions not linked" check
```

PI would load all 26 modules independently, in `readdir` order, and fail every one — none has a
default export.

### A `/model` list that is missing a provider entirely

Its `apiKey` is absent or does not resolve. PI drops the **whole catalogue** for a provider whose
key does not resolve, even for an endpoint that checks nothing.

```bash
config/bin/pi-tier --list
echo "${MY_TOKEN:-UNSET}"
```

See [`models.json` → `apiKey`](../configuration/models.md#apikey).

### An OAuth provider suddenly asks to log in again

Something re-declared its provider block and overwrote the state PI manages. A fragment for a
built-in provider must set `builtIn: true` and keep the block to a **minimum override**.

Also: never run `/login` against a path that has been re-pointed. See
[Adding a provider](../extending/providers.md#2-does-pi-already-ship-this-provider).

---

## Models, providers and context

### A hard failure mid-session, after things had been going fine

Almost always `contextWindow` declared larger than the endpoint actually serves. Compaction decided
it had room, and it did not.

```text
contextWindow = min(200000, what the endpoint actually serves)
```

Never copy the number off a model card. [Context windows](../concepts/context-windows.md).

### A 400 whose message names a field you did not set

A `compat` flag is wrong for this endpoint. Reset to everything off with
`maxTokensField: "max_tokens"`, get **one successful turn**, then enable one flag at a time.

The flag-to-symptom table is in [`models.json` → `compat`](../configuration/models.md#compat).

### The run aborted with a provider error and did not try anywhere else

Working as designed. `onProviderError` is `{"policy": "abort", "substituteProvider": false}`. There
is no failover and there will not be — a quiet substitution means you do not know which model
answered.

The abort report names provider, model, error class, message and cause chain. Read it; it is
usually enough. [`routing.json` → `onProviderError`](../configuration/routing.md#onprovidererror).

### Compaction fires too late, or too often

`reserveTokens` is a **single global scalar** for every model in the tree. It is not a per-model
threshold, and using it as one breaks providers.

The per-model lever is `providers.<p>.modelOverrides.<id>.contextWindow`.
[`settings.json` → compaction](../configuration/settings.md#compaction).

### Exit code 23 or 91 from a headless run

The compaction loop guard tripped: compaction stopped reducing the transcript. Usually the prompt or
a tool result is growing without bound.

`91` means the extension killed the process itself; `23` means it tried and `pi` exited 0 anyway.
[Exit codes](../reference/exit-codes.md#91--the-compaction-loop-guard-from-inside).

---

## Tools and permissions

### A command was refused and I want it allowed

Since the 2026-08-14 deny-list inversion, narrowed again on 2026-08-15, there are only three rule
families left that can refuse a bash command at all — read the refusal, it names the rule id:

| Prefix | Relaxable |
|---|---|
| `DB-*` | mostly not — two of the eight (`DB-CURL-SH`, `DB-SHUTDOWN`) take a written justification |
| `GIT-REWRITE` | with a written justification |
| `GIT-FORCE-PROTECTED` | with a written justification |

`SEC-*` is no longer on this list. Since 2026-08-15 it records a credential-path touch and permits
the call, so there is nothing to relax — and nothing at runtime keeping a credential out of the
model's context either. See
[Safety model](../concepts/safety-model.md#credential-reads-are-no-longer-refused).

If the id is not one of those three, it did not come from the guard's bash gates — check
[`hooks.yaml`](../configuration/tools.md#hooksyaml) for a declarative rule you or your team added.

### It asks me before every shell command and I want it to stop

Nothing in the guard prompts any more. If a shell command is stopping to ask, the guard is not the
cause — check `config/hooks.yaml` for a `select`/`confirm` action, or a project-level extension.

### A command runs that I expected to be refused

There is no allowlist to check any more. `PRV-*` (privileged commands: `sudo`, `chmod 777`,
`pkill -9`, `killall`), `FS-*` (writes outside the project) and `RTE-*` (generic-agent dispatch where
a specialist matches) are all **audit-only** since 2026-08-14 — permitted, and recorded in the
session's audit log as a `guard.observed` entry, but never refused. If you need one of those
enforced again for your own workflow, write a `run`/`select`/`confirm` rule in
[`hooks.yaml`](../configuration/tools.md#hooksyaml); the guard itself will not do it.

### A confirmation dialog timed out and the command did not run

The guard itself no longer raises any confirmation dialog. If you are seeing one, it came from a
hook you or your team configured in `config/hooks.yaml` — check that rule's own timeout.

### A hook stopped applying, or blocks everything

Hooks fail **closed** — deliberately, and on the opposite side from the guard. A hook whose
evaluation throws, whose action throws, or whose script is missing **blocks**.

A `run` rule with no script in place blocks every matching call, which is why none ships enabled.
[`hooks.yaml`](../configuration/tools.md#hooksyaml).

### A hook regex does not match what I expect

The engine is JavaScript's. **Inline PCRE flags like `(?i)` are not supported** and will not error —
they simply fail to match. Use a character class or the pattern's own flag field.

---

## Skills

### A skill I added never runs

Almost certainly a **name collision**, and yours lost. `loadSkills` keeps the *first* loader of each
name, and everything settings-driven resolves before anything contributed by an extension.

```text
/doctor      # D-02
```

Name your root in `config/settings.json`'s `skills` array. A root contributed only by
`resources_discover` sits behind even `~/.agents/skills`.
[Adding skills](../extending/skills.md#where-skills-are-found-and-in-what-order).

### A skill silently fails to load

Its frontmatter did not parse. The usual cause is an **unquoted colon** in `description`:

```yaml
description: "Default output dir: ./out"     # quote it
```

### `allowed-tools` in my skill is being ignored

It is inert. PI parses exactly three frontmatter fields. Use a
[sub-agent](../extending/subagents.md) if you need a real tool restriction.
[Known limitations](../limitations.md#allowed-tools-in-skill-frontmatter-does-nothing).

---

## Sub-agents

### An agent is listed but refuses when dispatched

It is **restricted**: it resolved, but nothing is currently serving its model. Usually an `optional`
tier whose backend is not running — start it — or a tier bound to a provider you did not configure.

(Before 2026-08-13 this status had a second cause, "its provider is classed looser than this
session". That rule was withdrawn; a class refuses nothing now.)

```text
/agents
```

### An agent file is not picked up at all

- `name:` must equal the filename without `.md`.
- It must be in one of `dispatch.json`'s `registryDirs`.
- A `fallbackModels` key makes it **invalid** — per-agent model fallback is refused by design.

### `isolation: worktree` refused the dispatch

Neither the worktree module nor the package's own worktree support was available. It does **not**
fall back to running in your checkout — an agent that asked for isolation asked for a reason.

### A sub-agent was blocked running a program I use all the time

That should not happen any more. There is no program allowlist, and nothing to approve for a
session or inherit into a child — every program runs headless with no prompt, unless the specific
*command shape* it is being used for is one of `DB-*`/`GIT-REWRITE`/`GIT-FORCE-PROTECTED`.
If a sub-agent is refused, read the rule id: it is one of those three, and the fix is the same one
described in [A command was refused and I want it allowed](#a-command-was-refused-and-i-want-it-allowed),
not a session-allowlist variable. `PI_GUARD_APPROVE` and `PI_GUARD_SESSION_ALLOWLIST` are removed —
setting either does nothing.

### A sub-agent "produced no output"

That is a description of a symptom, and on its own it says nothing about where the failure was. Look
for a `[pi-config] provider call failed` block with error class **`empty-response`** just before it:
that is a provider answering HTTP 200 with a well-formed body carrying no completion, and it names
the provider, model, finish reason, effective reasoning effort, zero usage and `responseId`. Nothing
else in the stack treats it as a failure, which is why it is detected explicitly. See
[`onProviderError`](../configuration/routing.md#onprovidererror) and, for a worked investigation of
one gateway's empty-200 behaviour, [the field notes](../extensions/credentials.md#field-notes-an-empty-200-investigation-2026-08-14).

### An async run is still reported as "running" long after it should have finished

It probably is not. The dispatcher's own completion notification can fail to deliver, and the
acknowledgement is then the only thing in context. The harness re-reads each async run's status file
at the end of every turn and announces terminal states itself, so a finished run surfaces even when
the notification did not — occasionally twice, which is deliberate. `/agents` prints the current
fleet on demand.

---

## MCP

### A project's MCP server is refused

Default-deny, by design. Approve it once, deliberately:

```bash
config/bin/pi-mcp-approve --status .
config/bin/pi-mcp-approve .
```

Being inside a trusted root grants **nothing** here — those are different questions.
[Adding MCP servers](../extending/mcp-servers.md#project-defined-servers).

### A previously approved project is refused again

Its MCP config changed, so the sha256 no longer matches the approval. That is the feature. Read the
diff `pi-mcp-approve` prints, then re-approve.

### A stdio MCP server starts by hand but not under `pi`

`mcp-stdio-guard` stripped an environment variable it needs. Name it in that server's own
`MCP_STDIO_EXTRA_ENV`:

```json
"env": { "MCP_STDIO_EXTRA_ENV": "MY_VAR", "MY_VAR": "value" }
```

This is the single most common MCP failure here, and the least obvious.

### A server another tool on this machine declares does not appear

`hostConfigDiscovery` is `"off"`. Copy the entry into `config/mcp.json` deliberately. Your tool
surface should not change because unrelated software updated.

---

## Headless and scheduled runs

### A scheduled job reports success but produced nothing

You used bare `pi -p`. **It exits 0 on a failed turn.** Use [`bin/pi-run`](cli.md#pi-run).

This is the single most important operational rule in the repository, and it is the failure that
motivated most of the wrapper.

### `pi -p` hangs forever

Open stdin with no TTY. `pi-run` gives the child `/dev/null` on stdin for exactly this reason.

### Exit code 22

Protocol drift — an assistant `message_end` carried no `stopReason`. `pi`'s stream shape changed
under the wrapper. Run the [API probe](verification.md#when-pi-itself-updates).

---

## When none of this helps

1. `/ctx-dump` — see exactly what the model was told. When it behaves as though it was told
   something you did not tell it, this is where you find out.
2. `/context` — see where the context window actually went.
3. `bin/pi-log events` — the last 200 recorded events.
4. `./scripts/postinstall-verify.sh --json` — a machine-readable snapshot worth attaching to a bug
   report.
5. [Known limitations](../limitations.md) — check whether it is a documented platform limit before
   spending an afternoon on it.

## Related

- [Command reference](cli.md) · [Verification](verification.md)
- [Configuration reference](../configuration/index.md)
- [Exit codes](../reference/exit-codes.md)
