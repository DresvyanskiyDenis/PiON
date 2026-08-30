# Writing a hook

A hook is a rule in `config/hooks.yaml` that watches tool calls and user input, and can block, warn,
ask, or hand the decision to a script. It is the extension point that needs no TypeScript: you edit
YAML, restart, and the rule applies.

This page walks from the simplest useful rule to a scripted one. The module's own behaviour — load
order, the fail-closed inversion, what happens to a broken file — is on
[`hooks`](../extensions/hooks.md).

!!! warning "Hooks can only add denial, never remove it"
    They stack **on top of** the [guard](../extensions/guard.md), which loads first. A hook cannot
    permit something the guard refused. There is no allowlist to be looking for any more —
    `DB-*`/`GIT-REWRITE`/`GIT-FORCE-PROTECTED` are the only things a bash command can be
    refused for by the guard itself, and none of them is configurable from here or from
    `config/guard.json`. `SEC-*` is audit-only since 2026-08-15, so a hook is now the only way to
    make a credential path refuse anything.

---

## The shape

```yaml
version: 1
rules:
  - id: no-force-push-main
    event: tool_call
    match: { tool: bash, pattern: 'git\s+push\b.*(--force|-f)\b.*\b(main|master)\b' }
    action: block
    reason: "Force-pushing main/master is blocked. Push to a feature branch, or use --force-with-lease with a written reason."
```

Five fields, and that is the whole language. There are no conditionals, no variables and no loops,
deliberately — every request for a sixth field is answered with "write it as a guard gate or a
sub-agent instead".

| Field | Values |
|---|---|
| `id` | unique across the global file *and* any project file. It is what diagnostics name |
| `event` | `tool_call` or `input` |
| `match.tool` | the tool name, for `tool_call` rules. Omit to match every tool |
| `match.pattern` | a JavaScript regular expression, matched against the call (or the input text) |
| `action` | `block` \| `warn` \| `confirm` \| `run` |
| `reason` | shown to the model and to you. Write it as an instruction, not a scolding |

Which actions are legal depends on the event, and this is checked at load time rather than left to
convention:

| Event | Allowed actions |
|---|---|
| `tool_call` | `block`, `warn`, `confirm`, `run` |
| `input` | `block`, `warn` |

`run` is not offered on `input`: a script gate belongs on the thing it is gating, and `confirm` has
no headless-safe meaning for text you already typed.

---

## Your first rule: block something

Say you never want the agent to run a database migration against production by accident.

```yaml
  - id: no-prod-migrate
    event: tool_call
    match: { tool: bash, pattern: '\bmigrate\b.*\bprod' }
    action: block
    reason: "Migrations against prod run from the deploy pipeline, never from an agent session."
```

Restart `pi` and try it. The `reason` is what the model reads, so write it as a redirect — telling it
*where the legitimate path is* stops it retrying the same thing three different ways.

## Your second rule: ask instead of refuse

`confirm` prompts you and waits.

```yaml
  - id: confirm-npm-install
    event: tool_call
    match: { tool: bash, pattern: '(^|[;&|]\s*)npm\s+(i|install)\b' }
    action: confirm
    reason: "This project installs with uv, not npm. Run npm install anyway?"
```

!!! danger "`confirm` has no meaning in a headless run"
    There is nobody to answer. Hooks fail **closed** — an unattended run refuses rather than
    guessing, which is correct, and is also why a `confirm` rule on a command your scheduled job
    needs will stop that job. Use `warn` for rules that should not gate automation.

## A nudge rather than a gate

`warn` on `input` reacts to what *you* typed, before the model sees it.

```yaml
  - id: remind-worktree
    event: input
    match: { pattern: '\b([Ii]mplement|[Rr]efactor|[Ff]ix the bug)\b' }
    action: warn
    reason: "Reminder: coding work happens in a git worktree, never the primary checkout."
```

!!! note "`match.pattern` is a plain JavaScript `RegExp` — no inline flags"
    JavaScript has no PCRE-style `(?i)`. Writing `pattern: '(?i)implement'` throws
    `Invalid group` at load, and the rule is **dropped** with a warning while the rest of the file
    loads. Use a bracket class on the letters that matter, as above.

    The other common surprise: your pattern is matched against the command text, so anchoring with
    `^` only matches the start of the whole call. `(^|[;&|]\s*)` is the idiom for "at the start of any
    command in a pipeline" — an attacker-shaped `true && npm install` sails past a bare `^npm`.

---

## The `run` action: let a script decide

`run` hands the decision to a program. This is for decisions a regular expression cannot express —
"is this file in a directory the current ticket touches?", "does this SQL hit a table on the
restricted list?".

```yaml
  - id: check-sql-tables
    event: tool_call
    match: { tool: bash, pattern: '\bpsql\b' }
    action: run
    run:
      command: /usr/local/bin/check-sql-tables
      args: ["--strict"]
      timeoutMs: 3000
```

!!! warning "`command` is not run through a shell"

    It is spawned directly, so `$VARS` are not substituted and no glob, pipe or redirect works.

    A **leading `~/` is expanded** to your home directory when the file is loaded, and that is the
    *only* substitution there is. It exists because the alternatives do not work: the command is
    checked with `access(X_OK)` and spawned with the **project** as `cwd`, so a bare name
    (`check-sql-tables`) is **not** searched on `PATH`, and a relative path (`./scripts/…`) silently
    means a different file in every repository you open. That left an absolute path with your
    username baked into a version-controlled config file, which is why no shipped rule used `run`
    at all until the constraint rules below.

    So: an **absolute path**, or `~/…` — and `~/bin/<script>` is exactly where the installer links
    everything in `config/bin/`, so a rule can name one portably. Arguments go in `args` as separate
    list entries, never packed into `command` as one string. If you genuinely need shell features,
    make the command your shell and put the script in `args`: `command: /bin/sh`,
    `args: ["-c", "..."]` — and accept that you have
    just taken responsibility for quoting whatever the agent passes you.

### The protocol

Your script receives a JSON object on **stdin**:

```json
{ "event": "tool_call", "ruleId": "check-sql-tables", "tool": "bash",
  "input": { "…": "the tool's own arguments" }, "cwd": "/where/the/session/is" }
```

and answers by how it exits:

| Script does | Verdict |
|---|---|
| exits `0` writing nothing | **no opinion** — the call proceeds. The only way a `run` rule permits anything |
| exits `0` writing `{"decision":"deny","reason":"…"}` | **deny**, with your reason |
| exits `2` | **deny**; stderr becomes the reason |
| exits anything else | **blocked** — treated as an infrastructure failure, not as permission |
| writes non-JSON on stdout | **blocked** |
| is missing or not executable | **blocked** |
| exceeds `timeoutMs` (default **5000 ms**) | **blocked** — `SIGTERM`, then `SIGKILL` 500 ms later |

A worked example, in the two lines it usually takes:

```bash
#!/usr/bin/env bash
# Deny anything that mentions a restricted table. Silence means "no opinion".
set -euo pipefail
payload=$(cat)
if grep -qE '\b(salaries|ssn_lookup)\b' <<<"$payload"; then
  printf '{"decision":"deny","reason":"restricted table — use the anonymised view"}\n'
fi
```

Make it executable (`chmod +x`), and give it an **absolute path** or a `~/…` path in `command`.

!!! danger "Fail-closed, on purpose — and what that means the day you write one"
    Every failure class above blocks. A missing script, a typo'd path, a `set -e` tripping on an
    unrelated line, a slow network call inside your script: all of them deny the tool call.

    A `run` rule with `match: { tool: bash }` and no script at the named path would block *every
    bash call in every session*, immediately, by design. Write the script first, test it by hand
    with `echo '{}' | your-script`, then add the rule. The only `run` rules that ship enabled are
    the two constraint rules below, and they name a script this repository ships and installs.

    The reasoning is on [ADR 0002](../adr/0002-fail-open-guard-fail-closed-hooks.md): a rule you wrote
    that silently stops applying **is** the bug.

Keep the script fast. It runs inside the tool call, and 5 seconds is the default ceiling — a script
that phones an API is a script that will one day block your session because someone else's service was
slow.

---

## Hard constraints: `constraints.json`

The rule this makes true: **a constraint written down as NEVER gets a hook; if it does not get a
hook, it was a preference.** Prose in `AGENTS.md`, in `SYSTEM.md` or in a project plan is advisory by
construction. "Do not use LangChain in this POC" sits in a plan file, an agent adds the dependency
anyway, and nothing objects, because the layer that could object knows about protected branches and
credential paths, not about project decisions. That is safe behaviour encoded as a model habit
rather than as system state, and habits are silent when they fail.

Two rules ship enabled — `constraints-edit` and `constraints-write` — and both run
`~/bin/pi-constraints-hook` (installed from `config/bin/`). The script reads two files and merges
them, global first:

| File | Holds |
|---|---|
| `~/.pi/agent/constraints.json` (i.e. `config/constraints.json`) | ships **empty on purpose** — a global ban applies to every repository this harness opens |
| `<project>/.pi/constraints.json` | where NEVERs actually belong, because they are project decisions |

```json
{ "version": 1, "constraints": [
  { "id": "no-langchain",
    "pattern": "\\b(?:import|from)\\s+langchain|langchain[_-]\\w+",
    "flags": "i",
    "paths": ["\\.py$"],
    "reason": "This POC talks to the endpoint directly; LangChain was ruled out in docs/plan.md." } ] }
```

`pattern` is matched against **only the text the call adds** — `write.content`,
`edit.edits[].newText` — never `oldText`. Matching removals would block the edit that *deletes* a
banned import: a gate standing in the way of complying with itself. `paths` (optional) scopes the
constraint to target paths one of its regexes matches, so the doc that quotes a banned string stays
writable. A writing tool whose input shape the script does not recognise is scanned wholesale, minus
the removal keys, rather than being silently exempt.

The refusal names the file, the rule and the way out, verbatim:

> constraint "no-langchain" from /home/…/.pi/constraints.json, rule says: … The text this write
> adds to src/transport.py matches /…/i. **Override path: none, ask the owner to change the
> constraint file in a commit.**

**Fail-closed, with one door left open.** An unparseable constraints file, or a constraint whose
regex does not compile, **denies** rather than degrading to "no constraints" — a silently disarmed
guard reads exactly like a satisfied one. The single exemption: a write to a constraints file itself
is never blocked, neither by a broken file nor by a matching constraint, because the declared
override path has to stay reachable. Without it, one bad regex locks you out of the only file that
could fix it. Both files absent is the one true no-op.

---

## Where the file lives, and project hooks

| File | When |
|---|---|
| `config/hooks.yaml` | yours, global, symlinked as `~/.pi/agent/hooks.yaml` |
| `<project>/.pi/hooks.yaml` | merged **after** the global file, and **only once the project is trusted** |

Global rules load first. A rule `id` should be unique across both — a project rule that reuses a
global id makes the diagnostics ambiguous, which is the one thing you need working when a hook
misfires.

Project hooks inherit the whole trust decision: an untrusted project's `.pi/` is inert. See
[Paths and trust](../configuration/paths-and-trust.md).

---

## When something is wrong with the file

Two different failures, treated differently on purpose:

- **One rule is broken** — missing `id`, an invalid regular expression, an action that does not apply
  to its event. That rule is named and dropped; every other rule still loads. One person's typo must
  not disable everyone's rules.
- **The file is broken** — invalid YAML, or the wrong top-level shape. The hook layer **degrades to
  "no hooks"**: it loads nothing and has no opinion, and it announces that loudly on stderr, in the
  UI, and through `/doctor`'s `D-09`.

The degrade behaviour is deliberate and was chosen over the alternative (refusing the session): this
file is not the last line of defence — [`guard`](../extensions/guard.md) is a separate module that
keeps working — and the earlier polarity meant one YAML typo bricked the session.

!!! warning "A degraded hook layer is invisible from the inside"
    Every tool call simply proceeds. That is exactly why the announcement is `error`-level and repeats
    every session. If you rely on a hook for something that matters, check `/doctor` after editing the
    file — do not infer from "nothing blew up" that your rules are live.

---

## Verifying

```bash
pi                 # restart — hooks compile at session start
/doctor            # D-09 reports a degraded hook layer, and dropped-rule warnings
```

Then trigger the rule deliberately. A hook you have never seen fire is a hook you have not tested.

## Related

- [`hooks`](../extensions/hooks.md) — the module, its load position and the fail-closed inversion
- [`config/hooks.yaml`](../configuration/tools.md#hooksyaml) — the field reference
- [`guard`](../extensions/guard.md) — the gates hooks stack on top of
- [ADR 0002](../adr/0002-fail-open-guard-fail-closed-hooks.md) — why hooks fail closed and the guard does not
