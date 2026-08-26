# Command reference

Everything you can run: the scripts in `bin/` and `config/bin/`, the install scripts in `scripts/`,
and the slash commands the extensions register inside a session.

---

## `bin/pi-run` { #pi-run }

**The single most important operational rule in this repository: never use bare `pi -p`
unattended. Use `pi-run`.**

```bash
bin/pi-run -p "summarise the diff on this branch"
bin/pi-run --help          # the exit-code table, from the source of truth
```

### Why it exists

`pi -p --mode json` **exits 0 on a failed turn**. A scheduled job that checks `$?` cannot tell
success from failure. And an extension cannot fix this from the inside: inside a pre-compaction
handler under `pi -p`, `ctx.shutdown()` and `ctx.abort()` both return `undefined` and do nothing, and
the session runs on and exits 0.

So the fix lives outside the process. `pi-run`:

- forces `--mode json` and **refuses any other mode** (exit `2`);
- gives the child `/dev/null` on stdin — `pi -p` with an open stdin and no TTY hangs;
- streams the child's stdout through unchanged;
- parses the stream and exits non-zero when the run actually failed;
- distinguishes an error `pi` **retried away** (reported as a note) from one it did not (a failure).

### Signals

`SIGINT`, `SIGTERM` and `SIGHUP` are forwarded to `pi`. `pi-run` then waits and reports `pi`'s own
fate. A `pi` that has not exited **5 seconds** after the forward is `SIGKILL`ed.

That 5 seconds is not taste: launchd sends `SIGKILL` 20 s after its `SIGTERM` and systemd 90 s. Five
leaves the wrapper 15 s of the tighter window to escalate, reap the child and print its blocks — so
the escalation always completes *inside* the supervisor's window, and the supervisor never has to
kill the wrapper out from under a child it was in the middle of killing.

Repeat signals are ignored. The escalation is already scheduled and must not be delayed.

### Compaction loop

Watched on two triggers: the sentinel file under `<stateRoot>/compaction-loop/<sessionId>.json` and
the loop entry on the stream. On either, `pi` gets 2 s to exit itself and is then `SIGTERM`ed.

### Environment

| Variable | Effect |
|---|---|
| `PI_RUN_PI_BIN` | the binary to execute (default `pi`) |
| `XDG_STATE_HOME` | where the compaction sentinel is looked for (default `~/.local/state`) |

Exit codes: [Exit codes](../reference/exit-codes.md#binpi-run).

---

## `bin/pi-check`

The repository's own rule set — `PC-*`. Run it before every commit and in CI.

```bash
bin/pi-check --all           # every rule that does not need the network
bin/pi-check --all --live    # adds PC-19, which queries the npm registry
bin/pi-check --only packages # the offline package subset
```

It asserts things that are invisible until they bite:

| Rule | Asserts |
|---|---|
| `PC-02` | no tier in `routing.json` points at a provider that is not in `models.json` |
| `PC-06` | no secret is committed — including in the tracked shell profile |
| `PC-09` / `PC-18` / `PC-19` | `package.json`, `packages.lock.json` and what is installed agree three ways |
| `PC-10` | no `<UPPERCASE_PLACEHOLDER>` token survives anywhere under `config/` |
| `PC-12` | no private-identity file is trackable |
| `PC-14` | the browser-cookie escape hatches are unset everywhere |
| `PC-15` | no extension source references the `X-Initiator` header |
| `PC-17` | every installed or vendored package tree ships a licence file |
| `PC-21` | the on-disk vendored tree matches its recorded per-file sha256 manifest |
| `PC-24` | every committed `path-rules` fixture has valid frontmatter and a supported glob |

Exit `0` = clean, `1` = findings, `2` = the checker could not run. That last distinction matters in
CI: treating them the same hides broken tooling behind a red build.

---

## `config/bin/pi-tier` { #pi-tier }

Resolves a semantic tier to a concrete model, from the shell. Useful in scripts and as a predicate.

```bash
config/bin/pi-tier --list              # every tier and what it resolves to
config/bin/pi-tier strong              # -> github-copilot/claude-opus-5:high
config/bin/pi-tier --thinking strong   # -> high
config/bin/pi-tier --egress databricks # -> confidential
```

**The tier's `thinkingLevel` is part of the answer**, appended as a `:<level>` suffix, because the
model string is the only channel PI reads reasoning effort from — see
[How `thinkingLevel` reaches the child](../configuration/routing.md#how-thinkinglevel-reaches-the-child).
Printing the bare id would run every `pi-tier`-driven call at the provider's default effort while
`routing.json` declared otherwise, which is the silent substitution this harness refuses to make.
A level already written into the tier's `model` wins and is not doubled; a level the harness does
not recognise exits `2` rather than travelling to the provider. `--thinking` still reports the
field on its own, for scripts that want the two halves separately.

Exit `2` means the lookup failed — an unknown tier, a tier this install left
[unbound](../configuration/routing.md#tiersunbound), an unusable `thinkingLevel`, or a provider with
no egress class. That is the cheapest possible answer to *"is this tier actually bound on this
machine?"*.

Requires `jq`.

---

## `config/bin/pi-mcp-approve`

The project-MCP trust ledger. See [Adding MCP servers](../extending/mcp-servers.md).

```bash
config/bin/pi-mcp-approve --status .   # what would happen right now
config/bin/pi-mcp-approve .            # print the config, then record approval
config/bin/pi-mcp-approve --list       # the whole ledger
```

`--status` exits `0` when allowed and `1` when refused, so it works as a shell predicate.

---

## `config/bin/mcp-stdio-guard`

Not run by hand. It is named as the `command` of a stdio MCP server entry, and re-execs the real
server through `env -i` plus an explicit allowlist. Exits `64` if given no command; otherwise it
`exec`s and the server's own exit status is what you see.

See [Safety model](../concepts/safety-model.md#mcp-stdio-guard).

---

## `bin/pi-log`

The session index's greppable face. Reads `index.db` directly and never opens it for write, so it
works with `pi` running.

```bash
bin/pi-log sessions     # last 50 sessions: title, model, turns, tokens, cost
bin/pi-log events       # last 200 events
bin/pi-log cost         # spend grouped by model
```

Requires the `sqlite3` CLI. Exits `1` if no index exists yet — run `/index` inside `pi` first.

---

## `bin/pi-digest-drain`

Drains the queued session digests, summarising each with the `light` tier. Intended for a scheduler.
Exits `1` rather than silently dropping a session it could not process.

See [`digest`](../extensions/digest.md).

---

## `bin/api-probe.mjs`

The drift detector. This repository depends on roughly 33 PI lifecycle events and an extension API
that moves fast — 0.84.1 shipped the day after 0.84.0.

It reads that surface **straight from the installed package's shipped `.d.ts` files** — never from
documentation, never from memory — and either records it or diffs the current surface against a
previously recorded lock, exiting non-zero when something depended on has been removed or renamed.

```bash
node bin/api-probe.mjs --pi "$(command -v pi)" --check
```

The recorded surface lives in `config/api-surface.lock.json`, which is
[not hand-editable](../configuration/not-editable.md).

!!! note "It resolves types, not the binary's behaviour"
    PI's standalone binary distribution ships no type declarations at all. `--pi` names the binary
    whose behaviour is in question; the probe then resolves the matching *types* in two steps and
    **refuses to proceed rather than guess**.

---

## `scripts/`

| Script | When |
|---|---|
| `scripts/install.sh` | first install, **and every reconfiguration afterwards** |
| `scripts/uninstall.sh` | removal |
| `scripts/verify-environment.sh` | *before* installing — does this machine have what PI needs |
| `scripts/postinstall-verify.sh` | *after* installing — are the symlinks, the pinned binary and the guardrail actually in place |
| `scripts/gen-skills-lint-matrix.mjs` | after changing any skill's frontmatter |

The two verify scripts are deliberately distinct. `verify-environment.sh` is a pre-install
environment probe; `postinstall-verify.sh` checks a machine **after** `install.sh` has run.
`install.sh` calls the latter itself as its final step.

Both take `--with-model` to make a real model call (spends tokens; off by default) and `--json` for
machine-readable output. Both exit `0` for no failures, `1` for at least one, `2` if the harness
itself could not run.

See [Verification](verification.md).

---

## Slash commands

Registered by the extensions, available inside a session.

| Command | Shows |
|---|---|
| `/doctor` | the nine `D-*` checks — start here when something is wrong |
| `/context` | where the context window has actually gone |
| `/agents` | the sub-agent registry, including invalid and restricted entries |
| `/compaction-status` | compaction thresholds and what the last pass did |
| `/path-defaults-status` | the configured default tier and per-channel policy |
| `/quota` | remaining provider quota |
| `/teammates` | live teammates |
| `/index` | build or refresh the session index `pi-log` reads |
| `/ctx-dump` | the assembled instruction context, verbatim |

`/ctx-dump` is the one people forget. When the model is behaving as though it was told something you
did not tell it, that command shows you exactly what it was told.

## Related

- [Exit codes](../reference/exit-codes.md)
- [Verification](verification.md) · [Troubleshooting](troubleshooting.md)
- [Extensions](../extensions/index.md)
