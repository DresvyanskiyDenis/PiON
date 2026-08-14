# `config/guard.json` — shell-execution safety

**Generated, not tracked.** `config/guard.default.json` is the template in git; the installer copies
it to `config/guard.json` and patches in your protected branches. The generated file is git-ignored
and is what `extensions/guard/policy.ts` reads at session start. Edit it in place — a re-run patches
rather than resets — and mirror into `config/guard.default.json` anything that must survive a fresh
clone.

The guard is a *permission layer*, not a sandbox. It refuses tool calls by pattern before they
run. It does not contain a process that has already started, and it does not stop code the model
never routed through a tool. What it buys you is that the small set of genuinely catastrophic
commands cannot run at all, no matter how a headless session got there.

The conceptual model — the six gates, three that block and three that only observe, the
fail-closed/fail-open contract, the deadman — is on
[Safety model](../concepts/safety-model.md). This page is the reference.

---

## 2026-08-14 — the deny-list inversion

This file used to carry an 83-name program allowlist, a headless policy (`nonInteractive`), an
escalation variable, a confirm timeout, an approval-UI choice and a remote allowlist — the whole
machinery behind a seventh gate (`ALW`) that refused any program not on the list, and refused it
*outright* headless because there was no one to ask.

That gate is gone, by owner decision. Not narrowed, not defaulted differently — removed as a
concept, along with the escalation and session-inheritance mechanisms that existed only to widen
it. Deciding safety by *program name* never worked well: a short list refused ordinary work, a long
list stopped meaning anything, and either way the actual boundary was somewhere else (see
[Known limitations](../limitations.md#the-guard-is-not-a-sandbox) for what that somewhere-else is).
What replaced it is a small, fixed set of catastrophic *command shapes*, blocked in code rather than
by config, plus three families (`PRV-*`, `FS-*`, `RTE-*`) that used to block and now only record
what they see. Removing enforcement was the decision; removing observability was not — a gate that
stopped being enforced still writes an audit entry every time it fires.

If you are reading this because you want the allowlist back: it was never the boundary, and this
file cannot bring it back on its own — there is no key left that means "decide by program name."

---

## Shipped file

```json
{
  "protectedBranches": ["main", "master"],
  "dispatchTools": ["task", "agent", "subagent", "dispatch_agent", "subagent_run"]
}
```

That is the whole file. Two keys: which branches a force-push cannot touch, and which tool names
count as "dispatching a sub-agent" for the one gate that still watches routing.

!!! warning "A missing or malformed `guard.json` does not disable the guard"
    `policy.ts` falls back to `DEFAULT_POLICY` — byte-for-byte the same content as the shipped
    JSON — sets `degraded: true`, and reports the problem loudly. Degradation cannot weaken
    `SEC-*`/`DB-*`/`GIT-*`: they are not read from this file at all. It can only mean
    `protectedBranches` falls back to `main`/`master`.

    An **unknown key** is rejected rather than ignored. A typo'd key that silently does nothing is
    how a policy stops applying without anyone noticing — and a key from the old shape (`allowlist`,
    `nonInteractive`, …) is now exactly as unknown as a typo.

---

## `protectedBranches`

```json
"protectedBranches": ["main", "master"]
```

Branches on which even `git push --force-with-lease` is refused, by the `GIT-FORCE-PROTECTED` rule.

Add your own long-lived branches — `develop`, `release/*`-style names, a shared integration branch.
This is a cheap, high-value edit and it is the one most people should make on day one.

**What breaks:** nothing, in the direction of adding. In the direction of removing: `GIT-FORCE-PROTECTED`
and `GIT-REWRITE` are *overridable with a written justification*, so a model can talk its way past a
destructive-git rule if it argues the case. `protectedBranches` is the list where "I have a good
reason" stops being accepted at all — a branch not on the list is not gated by this file, full stop.

There is also a declarative rule in [`config/hooks.yaml`](tools.md#hooksyaml),
`no-force-push-main`, which blocks force-push to `main`/`master` by regex. Two layers on the same
risk, on purpose: the hook is easy to read and easy to extend, the gate is harder to fool.

---

## `dispatchTools`

```json
"dispatchTools": ["task", "agent", "subagent", "dispatch_agent", "subagent_run"]
```

The tool names that count as "dispatching a sub-agent", for the `RTE-*` agent-routing observer. The
list is deliberately wider than the tool actually registered (`subagent`) because prose, older
agent definitions and other packages use the other names, and an observer that misses because the
tool was called `task` is an observer that records nothing.

Only change this if you add a package that registers a *differently named* dispatch tool — then add
its name.

The same list appears in [`config/dispatch.json`](dispatch.md); they serve different consumers and
both should name any new dispatch tool you add.

---

## The rule families this file does *not* configure

Everything that can actually **block** is in code, not data:

| Family | Examples | Overridable? |
|---|---|---|
| `SEC-*` secret paths | `SEC-SSH`, `SEC-PEM`, `SEC-ENV`, `SEC-PI-AUTH`, `SEC-PI-STATE`, `SEC-QUOTA-TOKEN`, `SEC-AWS-CRED` | **Never.** No config key, no override, no written justification |
| `DB-*` dangerous bash | `DB-RM-ROOT`, `DB-MKFS`, `DB-DD-DISK`, `DB-FORKBOMB`, `DB-CURL-SH`, `DB-SHUTDOWN`, `DB-CHMOD-777`, `DB-REDIR-DISK` | Two of the eight (`DB-CURL-SH`, `DB-SHUTDOWN`) — with a written justification. The rest, no |
| `GIT-REWRITE` | `git filter-repo`, `git filter-branch` | Yes — with a written justification |
| `GIT-FORCE-PROTECTED` | a force-push (any spelling) onto a `protectedBranches` name | Yes — with a written justification |

Everything else in `git` — `reset --hard`, `branch -D`, `clean -fd`, `checkout -- .`, a force-push
to any branch *not* in `protectedBranches` — is no longer gated at all. Each of those is
recoverable through the reflog or affects only untracked files; gating them cost real headless
runs for a safety margin the git history itself already provides.

And the three that used to block and now only **observe** — permitted, and written to the audit
log, with nothing returned to the model:

| Family | Examples | What it records |
|---|---|---|
| `PRV-*` privileged | `PRV-SUDO`, `PRV-KILLALL`, `PRV-PKILL-9`, `PRV-CHMOD-777` | A `guard.observed` entry naming the gate and the command |
| `FS-*` write surface | `FS-OUTSIDE` — a write whose target resolves outside the working directory and the session temp dir. `FS-UNRESOLVED` — a write whose target starts with a variable this process cannot resolve | The form (`sed -i`, `tee`, `cp` destination, …), the literal argument and the resolved path |
| `RTE-*` agent routing | `DV-SPECIALIST` — a generic agent dispatched where a specialist matches the prompt | The agent type that was dispatched |

None of the three can refuse a call, ask for confirmation, or return a reason to the model. They
exist so the transcript still answers "what did this session actually do to the filesystem, run as
root, or route to a generic agent instead of a specialist?" — a question worth being able to answer
even when nothing was stopped.

!!! warning "`GIT-REWRITE` blocks `filter-repo` and `filter-branch`, and a no-op rewrite is not safe"
    `git filter-repo` ends every run with the same post-pass, whether or not it changed a single
    commit: it deletes the `origin` remote, runs `reflog expire --expire=now --all` and
    `gc --prune=now`. Every reflog in the shared git dir goes to zero bytes — `logs/HEAD`, each
    branch reflog, and every linked worktree's own — so the commits survive and the way back does
    not. `--force` only suppresses the "this is not a fresh clone" refusal that would otherwise
    have stopped it. Rewrite a throwaway clone and push the result; if you really mean to do it in
    place, the written justification is there, and you are stating on the record that you accept
    losing the reflogs.

!!! danger "`FS-*` was never a container, and now it cannot even refuse"
    It reads the command string and locates write **forms** — `>`, `>>`, `tee`, `cp`, `mv`, `rm`,
    `install`, `truncate`, `dd`, `find -delete`, `curl -o` / `wget -O`, archive extraction, an
    in-place editor flag — then resolves each target against the working directory and the session
    temp dir. That is the whole mechanism, and since 2026-08-14 it only writes what it saw; it does
    not decide anything. It cannot see a write expressed *inside* a program (`python3 -c`, `node -e`,
    `awk '{print > "…"}'`, a `make` target, a `$( )` subshell). The full disclosure of what the guard
    does and does not contain is in
    [Known limitations](../limitations.md#the-guard-is-not-a-sandbox).

    It gates **bash command strings only**. It does not observe PI's own `write` / `edit` tools, and
    it does not gate reads; `SEC-*` covers the credential set on every tool, and `SEC-*` can still
    refuse.

If you want a *new* rule that can actually block, do not edit a gate — write it in
[`config/hooks.yaml`](tools.md#hooksyaml). Hooks stack on the guard and may only **add** denial,
never remove it.

---

## Verifying a change

The point of a permission layer is that you can demonstrate it. In an interactive session:

```text
run: sudo rm -rf /
```

You should get a refusal naming `DB-RM-ROOT` — not a confirmation prompt, not an execution.

Then `/doctor`. Its `D-06` check re-runs the synthetic probe `matchDangerous("rm -rf /")` and
confirms it still resolves to `DB-RM-ROOT`. **`D-06` is the only `/doctor` finding that shuts the
session down**, because a guard that loaded but no longer matches is worse than one that failed to
load.

## Related

- [Safety model](../concepts/safety-model.md) — the gates, the deadman, the fail-closed contract
- [`hooks.yaml`](tools.md#hooksyaml) — how to add your own rule
- [`bin/pi-run`](../operations/cli.md#pi-run) — why headless needs a wrapper at all
