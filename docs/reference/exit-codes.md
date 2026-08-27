# Exit codes

Every command in this repository exits non-zero when it failed. That sounds obvious; it is the whole
reason [`bin/pi-run`](../operations/cli.md#pi-run) exists, because `pi -p --mode json` does not.

Each table below was read out of the script itself. Run any of them with `--help` to see the same
table from the source of truth.

---

## `bin/pi-run`

| Code | Constant | Meaning |
|---|---|---|
| `0` | `EXIT_OK` | the stream completed and no assistant message ended in `error` or `aborted` |
| `2` | `EXIT_USAGE` | `pi-run` usage error — including any `--mode` other than `json` |
| `20` | `EXIT_TURN_FAILED` | an assistant `message_end` carried `stopReason: "error"` that was **not** retried away |
| `21` | `EXIT_TRUNCATED_STREAM` | no `agent_settled`, or no assistant `message_end` at all |
| `22` | `EXIT_PROTOCOL_DRIFT` | an assistant `message_end` carried **no** `stopReason` — the fail-open canary |
| `23` | `EXIT_COMPACTION_LOOP` | the compaction loop guard tripped and `pi` still returned 0 |
| `24` | `EXIT_TURN_ABORTED` | an assistant `message_end` carried `stopReason: "aborted"` |
| `127` | `EXIT_SPAWN_FAILED` | `pi` could not be spawned |
| `128+N` | — | `pi` was killed by signal `N`, including a signal `pi-run` forwarded to it |
| any other | — | `pi`'s own exit code, passed through unchanged |

`25`–`29` are **reserved** for further stream verdicts. Do not reuse them.

### Verdict precedence

```text
23 > 20 > 24 > 22 > 21
```

Several verdicts can apply to one run. `pi-run` prints **every block that applies** and exits with the
highest-precedence one, so a compaction loop is never hidden behind the turn failure it caused.

`pi`'s own non-zero exit always wins over all of them: if the process itself failed, that is the more
primitive fact.

### Why `22` exists

A stream that ends an assistant message with no `stopReason` field is not a success — it is a
protocol the wrapper does not recognise. Treating an unrecognised shape as `0` is precisely the
fail-open behaviour this wrapper was written to remove.

---

## `91` — the compaction loop guard, from inside { #91--the-compaction-loop-guard-from-inside }

`config/compaction.json` sets `compaction.loopGuard.headlessExitCode: 91`, and the compaction module
calls `process.exit(91)` directly when the guard trips in a headless run.

It is a **separate number from `pi-run`'s `23`** on purpose:

- `91` means *the extension noticed and killed the process itself.*
- `23` means *the extension noticed, wrote its sentinel, and `pi` exited `0` anyway* — the
  [platform limitation](../limitations.md#an-extension-cannot-abort-a-headless-run) that makes the
  wrapper necessary.

Seeing `23` rather than `91` tells you the in-process exit did not take effect. Both mean the same
thing operationally: the run was ended because compaction stopped making progress.

See [`compaction`](../extensions/compaction.md).

---

## `bin/pi-check`

| Code | Meaning |
|---|---|
| `0` | every rule passed |
| `1` | one or more findings — a rule failed |
| `2` | `pi-check` could not run: bad usage, an unreadable rule, a manifest it refused to write |

The `1` / `2` split matters in CI. `1` is *your repository is wrong*; `2` is *the checker is wrong or
was invoked wrongly*, and treating them the same hides broken tooling behind a red build.

A `2` from the manifest path specifically means it refused to write a **partial** manifest — a
half-recorded tree would make a later rule pass for the wrong reason.

---

## `config/bin/pi-tier`

| Code | Meaning |
|---|---|
| `0` | resolved — the model id, or the egress class, is on stdout |
| `1` | usage error, or a missing prerequisite (`jq`, or a readable `routing.json`) |
| `2` | **the lookup failed**: unknown tier, or no egress class for that provider |

Exit `2` is the one worth scripting against. `pi-tier <name>` returning `2` is the cheapest possible
answer to "is this tier actually bound?" — which is exactly what
[`tiersUnbound`](../configuration/routing.md#tiersunbound) documents in prose.

```bash
config/bin/pi-tier confidential || echo "not bound on this install"
```

---

## `config/bin/pi-mcp-approve`

| Code | Meaning |
|---|---|
| `0` | approved, already approved, or `--list` / `--status` reporting an **allowed** project |
| `1` | `--status` on a **refused** project, or nothing to approve (the directory carries no project MCP config) |
| `2` | usage error — no directory given, more than one, or a path that does not exist |

`--status` is designed to be used as a predicate:

```bash
config/bin/pi-mcp-approve --status . && echo trusted
```

See [`config/mcp.json`](../configuration/mcp.md) and
[Safety model](../concepts/safety-model.md#mcp).

---

## `config/bin/mcp-stdio-guard`

| Code | Meaning |
|---|---|
| `64` | no command was given to wrap |
| anything else | **the wrapped server's own exit code** — the guard `exec`s, so it does not stay in the process tree |

`64` follows the `sysexits.h` convention for a usage error. Because the guard replaces itself with the
server process, there is no second exit status to confuse with the server's own.

---

## `bin/pi-log`

| Code | Meaning |
|---|---|
| `0` | rows printed |
| `1` | no index database exists yet — run `/index` inside `pi` first |
| `2` | `sqlite3` is not on `PATH`, or an unknown subcommand |

The `1` / `2` split is the same distinction as `pi-check`'s: *nothing to show* versus *this tool
cannot run here*.

---

## `bin/pi-digest-drain`

| Code | Meaning |
|---|---|
| `0` | the queue drained, or there was nothing queued |
| `1` | it failed — an unreadable-but-present queue entry, a summariser that errored, an internal bug |

It exits `1` rather than swallowing the problem deliberately. A digest drainer that reports success
while dropping sessions is worse than one that stops.

---

## `scripts/install.sh`

| Code | Meaning |
|---|---|
| `0` | installed — or you declined at a confirmation prompt and nothing was changed |
| `1` | aborted, with a `PI-INSTALL-EXX` code, a cause and a suggested action |
| `130` | interrupted (Ctrl-C / SIGTERM) |

`0` covers "you said no" as well as "it worked", because declining is not a failure — the installer
asks before every destructive step and answering `n` leaves the machine exactly as it found it.

Every `1` carries a `PI-INSTALL-EXX` identifier, **including a bad flag**, which aborts as
`PI-INSTALL-E01` rather than with a separate usage code. Search this documentation for that code
rather than for the message text; the messages are written for humans and may be reworded, the codes
are not.

Note the asymmetry with the uninstaller below, which *does* use `2` for a usage error. Do not write a
driver that assumes the two scripts share one contract — read each table.

---

## `scripts/update.sh`

| Code | Meaning |
|---|---|
| `0` | up to date, or the update completed, or you declined at the confirmation |
| `1` | aborted, with a `PI-UPDATE-EXX` code, a cause and a suggested action |
| `3` | **`--check` only** — an update is available. Nothing was changed |
| `4` | the update landed, but `postinstall-verify.sh` reported failures. Read its table |
| `130` | interrupted (Ctrl-C / SIGTERM) |

`3` is deliberately not `1`. "There is an update waiting" is not a failure, and a driver that
cannot tell it apart from "I could not check" will either update on a network error or never update
at all. The same reasoning as the uninstaller's `3`, applied to a different question.

`4` says the checkout moved but the machine may not be right yet — a symlink the update could not
make, a runtime pin that has moved past the installed binary. The update is not rolled back, because
the repository state is correct; what is out of step is the install around it, and
`./scripts/install.sh --repair` is the fix.

The three refusals that produce `1` are the ones worth scripting against, and all three are
deliberate: `PI-UPDATE-E07` (uncommitted changes), `PI-UPDATE-E11` (the branch has diverged) and
`PI-UPDATE-E12` (an untracked file where upstream adds a tracked one). None of them is recoverable
by a script without discarding something a person wrote.

---

## `scripts/uninstall.sh`

| Code | Meaning |
|---|---|
| `0` | clean — everything listed was removed, or kept by an explicit choice. Also "nothing to remove" |
| `1` | fatal — could not run to completion; see the `FAILED` block printed above the exit |
| `2` | usage error |
| `3` | **partial** — it finished, but at least one item was skipped and needs manual follow-up |
| `130` | interrupted partway through — re-run to finish; some items may already be gone |

`3` is the code worth scripting against, and it is the reason the uninstaller does not simply exit
`0` or `1`. Some things genuinely cannot be removed for you: a symlink that has since been re-pointed
somewhere else, a Keychain item the OS refuses to unlock, a global `npm uninstall -g` that failed, or
a global package that cannot be identified at all because the install manifest is gone. None of those
is a crash, and none of them is success either.

Every skip is printed above the exit with its reason and, where one exists, the exact command that
finishes the job by hand. So a driver script should read it as:

```bash
set -uo pipefail
code=0
./scripts/uninstall.sh --yes || code=$?

case $code in
  0) echo "fully removed" ;;
  3) echo "removed, but read the skipped items above" >&2 ;;
  *) echo "did not finish — exit $code" >&2; exit "$code" ;;
esac
```

Use `--dry-run` first. It prints the identical preview and removes nothing, and it is the only
honest way to find out what an install left on a machine you did not set up yourself.

---

## Using these from a scheduler

```bash
#!/usr/bin/env bash
set -uo pipefail          # NOT -e: the exit code is the whole point

code=0
~/pi-config/bin/pi-run -p "$(cat prompt.txt)" || code=$?

case $code in
  0)      exit 0 ;;
  23|91)  echo "compaction loop — the prompt is probably growing without bound" >&2 ;;
  20)     echo "the turn failed — check the provider block in the output" >&2 ;;
  22)     echo "protocol drift — pi's stream shape changed; re-read pi-run" >&2 ;;
esac
exit "$code"
```

Never substitute bare `pi -p` here. It exits `0` on a failed turn, and this whole page becomes
decorative.

## Related

- [`bin/pi-run`](../operations/cli.md#pi-run) — the wrapper and its signal handling
- [Verification](../operations/verification.md) — the runbook that exercises these paths
- [Known limitations](../limitations.md#platform-limits--things-pi-does-not-let-an-extension-do)
