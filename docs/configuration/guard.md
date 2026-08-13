# `config/guard.json` — shell-execution safety

**Generated, not tracked.** `config/guard.default.json` is the template in git; the installer copies
it to `config/guard.json` and patches in your headless policy, protected branches and any allowlist
additions. The generated file is git-ignored and is what `extensions/guard/policy.ts` reads at
session start. Edit it in place — a re-run patches rather than resets — and mirror into
`config/guard.default.json` anything that must survive a fresh clone.

This is the sharpest file in the repository. Every other page here describes a preference;
**relaxing this one is a real decision with a real consequence**, and the page says so rather than
listing field names.

The guard is a *permission layer*, not a sandbox. It refuses tool calls by pattern before they
run. It does not contain a process that has already started, and it does not stop code the model
never routed through a tool. What it buys you is that the obviously catastrophic and the quietly
expensive both require a human to say yes.

The conceptual model — the six gates, the policy order, the fail-closed/fail-open contract, the
deadman — is on [Safety model](../concepts/safety-model.md). This page is the reference.

---

## Shipped file

```json
{
  "nonInteractive": "allowlist-only",
  "allowlist": ["git", "npm", "npx", "node", "uv", "uvx", "python", "pytest",
                "ruff", "mypy", "sleep", "echo", "cat", "ls", "rg", "fd",
                "jq", "make", "docker", "gh"],
  "escalation": "PI_GUARD_APPROVE=1",
  "approvalUi": "select",
  "confirmTimeoutMs": 120000,
  "protectedBranches": ["main", "master"],
  "remoteAllowlist": [],
  "dispatchTools": ["task", "agent", "subagent", "dispatch_agent", "subagent_run"]
}
```

!!! note "The policy ships as data, deliberately"
    Extending the allowlist is a config commit, not an edit to a gate. That is why the file exists
    at all.

!!! warning "A missing or malformed `guard.json` does not disable the guard"
    `policy.ts` falls back to `DEFAULT_POLICY` — byte-for-byte the same content as the shipped
    JSON — sets `degraded: true`, and reports the problem loudly. Gates read `degraded` and get
    **stricter**, never looser. You cannot turn the guard off by deleting its config; you can only
    make it complain.

    An **unknown key** is rejected rather than ignored. A typo'd key that silently does nothing is
    how a policy stops applying without anyone noticing.

---

## `nonInteractive`

The single most consequential key in the file. It answers: *what does an allowlist miss mean when
there is no UI to prompt with?* — i.e. under `pi -p`, cron, CI, or a sub-agent.

| Value | Behaviour | Who wants it |
|---|---|---|
| `"deny-all"` | bash is refused outright in a headless session | A scheduled job that should never shell out. The strictest posture that still starts |
| **`"allowlist-only"`** (ships) | the allowlist runs; a miss is **blocked** | Everyone, by default |
| `"allow-all"` | every command runs unprompted | A disposable container you are willing to lose |

!!! danger "`allow-all` is not 'convenient', it is 'unattended arbitrary execution'"
    In an interactive session an allowlist miss shows you a prompt and you decide. Headless there
    is nobody to ask, so the only two honest answers are *block* and *run it*. `allow-all` picks
    the second for every command a model can compose, for the entire run, with no record of the
    decision because no decision was made.

    If you need one specific command unattended, add **that program** to `allowlist`. If you need
    one specific *run* escalated, use `escalation` — it is per invocation and leaves the policy
    intact.

The gates above the allowlist (`SEC-*`, `DB-*`, `GIT-*`, `PRV-*`) still apply under `allow-all`.
It relaxes the last gate, not the file.

---

## `allowlist`

**Program basenames** — not command lines, not patterns — that run without an approval prompt.

```json
"allowlist": ["git", "npm", "node", "uv", "python", "rg", "jq", "docker", "gh"]
```

Adding an entry is the normal way to stop being asked about a tool you use constantly. Ask two
questions before you do:

1. **Can this program run another program?** `sh`, `bash`, `zsh`, `env`, `xargs`, `find -exec`,
   `ssh`, `sudo` and friends turn one allowlist entry into all of them. Adding `sh` is
   indistinguishable from `nonInteractive: "allow-all"`.
2. **Can it write outside the project?** An allowlisted installer or package manager can, by
   design.

!!! note "`docker` is on the shipped list and is worth a second look"
    `docker run -v /:/host …` is a filesystem escape. It ships allowlisted because the alternative
    — a prompt on every container command — made the harness unusable for container work, and
    because `SEC-*` and `DB-*` still cover the paths that matter most. If you do not use
    containers, removing it is a free tightening.

**What breaks if you get it wrong:** too tight and headless runs stall on blocked commands (loud,
recoverable, annoying). Too loose and a model composes something you would not have approved, with
no prompt and no record (quiet, not recoverable). The failure modes are not symmetric; err tight.

---

## `escalation`

```json
"escalation": "PI_GUARD_APPROVE=1"
```

The environment variable that promotes a single headless invocation to "approved":

```bash
PI_GUARD_APPROVE=1 pi-run -p "run the full migration" --model "$(pi-tier fast)"
```

**Never set this in your shell profile.** It is per invocation on purpose: the value of the
mechanism is that a human typed it for *this* run, next to the command they were approving. Export
it globally and every headless run is escalated, including the ones a cron job starts at 03:00.

Rename the variable if it collides with something in your environment; the shape is
`NAME=value`.

---

## `approvalUi` and `confirmTimeoutMs`

| Key | Ships | Options |
|---|---|---|
| `approvalUi` | `"select"` | `select` gives allow-once / allow-session / deny. `confirm` is a two-way yes/no |
| `confirmTimeoutMs` | `120000` | Milliseconds before the dialog times out |

!!! warning "A timed-out dialog is a DENY"
    Not a default-yes, not a hang. If you walk away from a prompt, the command does not run. Raise
    the timeout if you routinely step away mid-run; do not lower it below the time it takes you to
    read what you are approving.

`allow-session` on the `select` UI grants for the remainder of the session, which is a real grant —
it is the option to reach for when a build loop needs the same command forty times, and the option
to avoid when you are approving something you have not read.

---

## `protectedBranches`

```json
"protectedBranches": ["main", "master"]
```

Branches on which even `git push --force-with-lease` is refused, by the `GIT-FORCE-PROTECTED` rule.

Add your own long-lived branches — `develop`, `release/*`-style names, a shared integration branch.
This is a cheap, high-value edit and it is the one most people should make on day one.

**What breaks:** nothing, in the direction of adding. In the direction of removing: the `GIT-*`
family is *overridable with a written justification*, so a model can talk its way past a
destructive-git rule if it argues the case. `protectedBranches` is the list where "I have a good
reason" stops being accepted.

There is also a declarative rule in [`config/hooks.yaml`](tools.md#hooksyaml),
`no-force-push-main`, which blocks force-push to `main`/`master` by regex. Two layers on the same
risk, on purpose: the hook is easy to read and easy to extend, the gate is harder to fool.

---

## `remoteAllowlist`

```json
"remoteAllowlist": []
```

Remotes `git push` may target. **Empty means any.**

Populate it with your real remote names (`origin`, and whatever else you legitimately push to) if
you work in a tree that has more than one and pushing to the wrong one would matter. On a
single-remote checkout it buys nothing.

---

## `dispatchTools`

```json
"dispatchTools": ["task", "agent", "subagent", "dispatch_agent", "subagent_run"]
```

The tool names that count as "dispatching a sub-agent", for the `RTE-*` agent-routing veto. The
list is deliberately wider than the tool actually registered (`subagent`) because prose, older
agent definitions and other packages use the other names, and a routing veto that misses because
the tool was called `task` is a veto that does not exist.

Only change this if you add a package that registers a *differently named* dispatch tool — then add
its name. Removing names weakens the veto silently.

The same list appears in [`config/dispatch.json`](dispatch.md); they serve different consumers and
both should name any new dispatch tool you add.

---

## The rule families this file does *not* configure

The gates run in policy order and only the last one is data-driven:

| Family | Examples | Overridable? |
|---|---|---|
| `SEC-*` secret paths | `SEC-SSH`, `SEC-PEM`, `SEC-ENV`, `SEC-PI-AUTH`, `SEC-PI-SECRETS`, `SEC-QUOTA-TOKEN`, `SEC-AWS-CRED` | **Never.** No config key, no escalation, no written justification |
| `DB-*` dangerous bash | `DB-RM-ROOT`, `DB-MKFS`, `DB-DD-DISK`, `DB-FORKBOMB`, `DB-CURL-SH`, `DB-SHUTDOWN`, `DB-CHMOD-777`, `DB-REDIR-DISK` | No |
| `GIT-*` destructive git | `GIT-FORCE`, `GIT-FORCE-PROTECTED`, `GIT-RESET`, `GIT-CLEAN`, `GIT-CHECKOUT-DOT`, `GIT-BRANCH-D`, `GIT-REMOTE` | Yes — with a written justification |
| `PRV-*` privileged | `PRV-SUDO`, `PRV-KILLALL`, `PRV-PKILL-9`, `PRV-CHMOD-777` | No |
| `RTE-*` agent routing | egress ceiling on dispatch | No |
| `ALW-*` allowlist | the miss | Confirm in the TUI; fail closed headless |

If you want a *new* rule, do not edit a gate — write it in
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
