# `guard` — the permission layer PI does not have

**Loads first, always.** PI's core is read / bash / edit / write plus a single `tool_call` block
primitive. This module is the policy on top of it.

Configured by [`config/guard.json`](../configuration/guard.md), which is where you should go for the
key-by-key reference and for the consequences of relaxing anything.

## Six gates, in policy order

The order is itself the policy: cheap and absolute first, the one that can block on a human last.

| Order | Gate | Rule ids | Override |
|---|---|---|---|
| 1 | secret paths | `SEC-SSH`, `SEC-PEM`, `SEC-ENV`, `SEC-KEY`, `SEC-AWS`, `SEC-AWS-CRED`, `SEC-CREDJSON`, `SEC-SECRETSDIR`, `SEC-SESSION`, `SEC-TOKENCACHE`, `SEC-PI-AUTH`, `SEC-PI-SECRETS`, `SEC-PI-STATE`, `SEC-QUOTA-TOKEN`, `SEC-QUOTA-PAT` | **never** |
| 2 | dangerous bash | `DB-RM-ROOT`, `DB-MKFS`, `DB-DD-DISK`, `DB-FORKBOMB`, `DB-CURL-SH`, `DB-SHUTDOWN`, `DB-CHMOD-777`, `DB-REDIR-DISK` | mostly none |
| 3 | destructive git | `GIT-FORCE`, `GIT-FORCE-PROTECTED`, `GIT-RESET`, `GIT-CLEAN`, `GIT-CHECKOUT-DOT`, `GIT-BRANCH-D`, `GIT-REMOTE` | with a written justification |
| 4 | privileged commands | `PRV-SUDO`, `PRV-CHMOD-777`, `PRV-PKILL-9`, `PRV-KILLALL` | none |
| 5 | agent routing | `RTE-*` — the specialist-match veto on dispatch | a SHOULD-level veto, overridable |
| 6 | bash allowlist | `ALW-*` | confirm in the TUI; **fail closed** headless |

Gate 1 is absolute by construction. There is no config key, no escalation variable and no
justification that opens a secret path — a permission layer whose strongest rule has an escape
hatch has no strongest rule.

## Why it does not delegate to a sandbox

An OS-level sandbox package exists and was reviewed. It is not this, and this gate never delegates
to it: its read-deny is explicitly not a hard block, and its network filter is a local
TLS-intercepting proxy with a generated CA whose interaction with corporate TLS inspection is
unresolved. A gate that sits above a sandbox and assumes the sandbox holds is two layers with one
guarantee between them.

## The policy is data

`config/guard.json` is loaded, not compiled in. Extending the allowlist is a config commit rather
than an edit to a gate.

A **missing or malformed** policy file does not disable the guard. `policy.ts` falls back to
`DEFAULT_POLICY` — the same content the shipped JSON carries — sets `degraded: true`, and reports
the problem loudly. Gates read `degraded` and get **stricter**, never looser. An unknown key is
rejected rather than ignored, because a typo'd key that silently does nothing is how a policy stops
applying without anyone noticing.

## Internal-error posture

The guard registers with `onInternalError: "open"`. A bug in *our* code must not blanket-block
every tool call on your machine. That is the opposite of [hooks](hooks.md), and the asymmetry is
deliberate — see [Safety model](../concepts/safety-model.md).

The safety net for "the guard did not load at all" is the [`trust`](trust.md) deadman, not this
module.

## Proving it works

In a session: `run: sudo rm -rf /` must be refused **naming `DB-RM-ROOT`**. Then `/doctor` — its
`D-06` re-runs a synthetic `matchDangerous("rm -rf /")` probe and is the only finding that shuts
the session down.

## Related
[`guard.json`](../configuration/guard.md) · [`hooks.yaml`](../configuration/tools.md#hooksyaml) ·
[Safety model](../concepts/safety-model.md) · [trust](trust.md) · [doctor](doctor.md)
