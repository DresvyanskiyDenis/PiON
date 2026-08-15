# `guard` — the permission layer PI does not have

**Loads first, always.** PI's core is read / bash / edit / write plus a single `tool_call` block
primitive. This module is the policy on top of it.

Configured by [`config/guard.json`](../configuration/guard.md), which is where you should go for the
key-by-key reference and for the consequences of relaxing anything.

## Six gates, two that block and four that only observe

**2026-08-14 — the deny-list inversion.** This used to be seven gates ending in a program allowlist
(`ALW-*`) that refused headless by default and confirmed in the TUI. That gate is gone as a concept,
along with the escalation variable and the session-inheritance mechanism (`PI_GUARD_SESSION_ALLOWLIST`)
that existed only to widen it — deciding safety by *program name* never worked well, and what
replaced it is a small, fixed set of catastrophic command shapes, decided by code rather than by
config. Three of the remaining gates were downgraded from blocking to audit-only in the same
change: they still see everything, they just no longer refuse anything. **On 2026-08-15 `SEC` was
downgraded the same way** — it was the last gate blocking for a reason other than destruction, and
by owner decision the rule applies to it too: only catastrophic commands block, and reading a file
is not catastrophic. Two gates block; four observe. The order is still the policy — cheap and
absolute first, so a match is reported under the most informative id.

| Order | Gate | Rule ids | Verdict |
|---|---|---|---|
| 1 | secret paths | `SEC-SSH`, `SEC-PEM`, `SEC-ENV`, `SEC-KEY`, `SEC-AWS`, `SEC-AWS-CRED`, `SEC-CREDJSON`, `SEC-SECRETSDIR`, `SEC-SESSION`, `SEC-TOKENCACHE`, `SEC-PI-AUTH`, `SEC-PI-SECRETS`, `SEC-PI-STATE`, `SEC-QUOTA-TOKEN`, `SEC-QUOTA-PAT` | **observes only** — permitted, recorded |
| 2 | dangerous bash | `DB-RM-ROOT`, `DB-MKFS`, `DB-DD-DISK`, `DB-FORKBOMB`, `DB-CURL-SH`, `DB-SHUTDOWN`, `DB-CHMOD-777`, `DB-REDIR-DISK` | blocks, mostly not overridable |
| 3 | destructive git | `GIT-REWRITE`, `GIT-FORCE-PROTECTED` | blocks, overridable with a written justification |
| 4 | privileged commands | `PRV-SUDO`, `PRV-CHMOD-777`, `PRV-PKILL-9`, `PRV-KILLALL` | **observes only** — permitted, recorded |
| 5 | write surface | `FS-OUTSIDE`, `FS-UNRESOLVED` — a bash write whose target is outside the working directory and the session temp dir, or cannot be shown to be inside | **observes only** — permitted, recorded |
| 6 | agent routing | `RTE-*` — a generic agent dispatched where a specialist matches the prompt | **observes only** — permitted, recorded |

Gate 1 no longer stops anything. `cd ~/.aws && cat credentials` runs, and the AWS credentials land
in the model's context and go to the provider serving the next turn; the `SEC-AWS` record is the
whole of what is left. **No runtime control in this repository prevents that** — the committed-secrets
scrub rule is push-time and protects the repository, not the context, and the OS-level sandbox
package is declared but imported by nothing. The consequence in full, and the one-line path back to
enforcement, are in [Safety model](../concepts/safety-model.md#credential-reads-are-no-longer-refused).

The four observing gates write a `guard.observed` audit entry — same shape as a `guard.block` entry,
plus what was seen — every time they fire. Removing enforcement did not remove observability: a form that stopped
being recorded after this change is a regression, not a simplification. `git reset --hard`,
`git branch -D`, `git clean -fd`, `git checkout -- .` and an ordinary force-push (to a branch outside
`protectedBranches`) are no longer gated *or* recorded at all — those are treated as ordinary git,
not merely tolerated.

If you are reading this looking for `PI_GUARD_APPROVE` or `PI_GUARD_SESSION_ALLOWLIST`: both are
removed rather than left inert. Neither name does anything any more.

## Why it does not delegate to a sandbox

An OS-level sandbox package exists and was reviewed. It is not this, and this gate never delegates
to it: its read-deny is explicitly not a hard block, and its network filter is a local
TLS-intercepting proxy with a generated CA whose interaction with corporate TLS inspection is
unresolved. A gate that sits above a sandbox and assumes the sandbox holds is two layers with one
guarantee between them.

**There is therefore no OS-level containment around bash at all**, and nothing is auto-approved for
being sandboxed, because nothing is sandboxed.

## The policy is data — what's left of it

`config/guard.json` is loaded, not compiled in, and carries exactly two keys now:
`protectedBranches` and `dispatchTools`. There is nothing left in it that widens what runs — the
deny-list itself lives in code.

A **missing or malformed** policy file does not disable the guard. `policy.ts` falls back to
`DEFAULT_POLICY` — the same content the shipped JSON carries — sets `degraded: true`, and reports
the problem loudly. Degradation can only mean `protectedBranches` falls back to `main`/`master`; it
cannot loosen `SEC-*`/`DB-*`/`GIT-*`, which do not read this file. An unknown key is rejected rather
than ignored, because a typo'd key that silently does nothing is how a policy stops applying without
anyone noticing — and any key from the old shape (`allowlist`, `nonInteractive`, `escalation`, …) is
now exactly as unknown as a typo.

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
