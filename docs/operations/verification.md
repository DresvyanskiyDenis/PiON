# Verification runbook

How to prove the install actually works — before you rely on it, and again after any change that
could have broken something quietly.

There are three layers, cheapest first. Run them in order.

```mermaid
flowchart LR
    A["scripts/verify-environment.sh<br/>before installing"] --> B["scripts/postinstall-verify.sh<br/>after installing"]
    B --> C["bin/pi-check --all<br/>every commit"]
    C --> D["/doctor<br/>every session"]
```

---

## Layer 0 — before installing

```bash
./scripts/verify-environment.sh
```

An environment probe: *does this machine have what PI needs*. It runs every non-interactive check
and prints one `PASS` / `FAIL` / `WARN` / `SKIP` table. Nothing it does writes to `~/.pi/agent` —
every probe uses an isolated `PI_CODING_AGENT_DIR`.

| Flag | Adds |
|---|---|
| `--with-model` | checks that make **real model calls** (spends tokens) |
| `--with-slow` | the 62-minute bash-timeout ceiling probe |
| `--model <provider/id>` | which model the `--with-model` checks use |
| `--ca <path>` | a corporate CA bundle to validate |
| `--json` | machine-readable output |

Exit `0` = no failures, `1` = at least one, `2` = the harness itself could not run.

### What the interesting checks actually establish

These are not smoke tests; several of them are the measurements the whole design rests on.

| Check | Establishes |
|---|---|
| `V-01` | whether `pi -p` exits non-zero on provider failure. **It does not.** This is why [`pi-run`](cli.md#pi-run) exists |
| `V-08` | whether an extension can abort a print-mode run. **It cannot** |
| `V-04` | whether `resources_discover` replaces or extends the built-in skill scan. **It extends** — a mask is impossible |
| `V-05` | whether a skill's `sourceInfo.baseDir` is populated. The answer is *not always*, which is why [`skills-env`](../extensions/skills-env.md) exists |
| `V-14` | whether the standalone binary honours `NODE_EXTRA_CA_CERTS` |
| `V-15` | whether `NO_PROXY` covers `127.0.0.1` and `localhost` — get this wrong and local model traffic goes through a proxy |
| `V-17a` / `V-17b` | the bash timeout ceiling, and whether truncated output is retrievable |
| `V-22` | whether an offline start is clean, and whether the model catalogue refreshes anyway |

A `WARN` here is worth reading. Several of them encode a finding rather than a fault.

---

## Layer 1 — after installing

```bash
./scripts/postinstall-verify.sh
```

`install.sh` runs this itself as its final step, so a clean install has already passed it. Run it
again after any change to the symlink layout, the pinned binary or the guardrails.

| Check | Asserts |
|---|---|
| pi version pinned | the binary on `PATH` is the version this tree was written against |
| config symlinks resolved | `~/.pi/agent/*` really points into the repository |
| **extensions not linked** | `~/.pi/agent/extensions` is **not** a symlink to `extensions/` — see below |
| state not in git | session state is not being written into the tracked tree |
| `pi-check --all` | the repository's own rules pass |
| extensions loaded | every declared module registered |
| **guardrail blocks `rm -rf`** | the guard is not merely loaded but actually refusing |
| skills discovered | the roots resolved |
| tools registered | the declared tools exist |
| TLS/proxy env | the CA bundle and proxy variables are coherent |
| provider credentials | *(warn only)* each configured provider is reachable |
| `fd` / `rg` present | *(warn only)* the search tools the agent prefers |

Opt-in, off by default:

```bash
./scripts/postinstall-verify.sh --with-model --model <provider/id>   # one live round trip
./scripts/postinstall-verify.sh --credentials                        # resolve every credential reference
./scripts/postinstall-verify.sh --json                               # for CI
```

!!! danger "The `extensions not linked` check is not pedantry"
    PI discovers `extensions/*.ts` and `extensions/<dir>/index.ts` and loads each as a **separate**
    extension in `readdir` order. A symlinked directory would therefore try to load all 27 modules
    independently, fail every one that has no default export, and destroy the load order the
    [safety model](../concepts/safety-model.md) depends on.

    `config/settings.json` names **one file** — the composition root — on purpose.

!!! warning "`guardrail blocks rm -rf` is the check that matters most"
    Every other check tells you the harness is installed. This one tells you it is *working*. A
    guard that loaded but stopped matching is the failure mode the whole
    [deadman](../concepts/safety-model.md#3-the-deadman) exists for.

---

## Layer 2 — every commit

```bash
bin/pi-check --all           # every rule that does not need the network
bin/pi-check --all --live    # adds PC-19, which queries the npm registry
```

Twenty-one `PC-*` rules. See [Command reference](cli.md#binpi-check).

A rule tagged `live` is **never** run without `--live` — it is reported as skipped rather than
silently dropped, so a CI run that cannot reach the network says so instead of quietly checking
less.

!!! note "It runs on a bare clone, and on an installed tree it checks *your* config"
    The rules that read a generated file — `PC-01`, `PC-02`, `PC-04`, `PC-20` — fall back to the
    tracked `config/<name>.default.json` when its generated twin is absent. So `--all` is meaningful
    on a fresh clone, before any install, and CI needs no seeding step. After an install the same
    rules read your generated files instead, which is when the check is about *your* configuration
    rather than the shipped one. Run it both times.

    `PC-06` is the exception in the other direction: it needs `git ls-files`, and it *says so* rather
    than passing silently when it cannot enumerate the tracked tree — an unknown is not a clean pass.

---

## Layer 3 — every session

```text
/doctor
```

Nine `D-*` checks, and a cheap subset runs automatically at every `session_start`. Full table:
[`doctor`](../extensions/doctor.md).

Two are worth knowing by heart:

- **`D-04`** — every tier in `routing.json` resolves to a model in the registry **and** that model
  has a credential. This is the check that catches "I added a provider and forgot the token".
- **`D-06`** — the guard loaded **and** its synthetic probe still resolves `rm -rf /` to
  `DB-RM-ROOT`. **The only finding that shuts the session down.**

---

## Verifying a specific thing

| I changed… | Run |
|---|---|
| a provider or a tier | `config/bin/pi-tier --list`, then `/doctor` for `D-04` |
| `guard.json` | `bin/pi-check --all`, then try a command you expect to be refused |
| a skill | restart, then `/doctor` for `D-02` |
| an agent file | `/agents`, then `bin/pi-check --all` for `PC-04` / `PC-05` |
| `mcp.json` | `/doctor` for `D-07`; for a project config, `pi-mcp-approve --status .` |
| a package version | `bin/pi-check --all --live` for `PC-09` / `PC-18` / `PC-19` |
| the pinned PI version | `node bin/api-probe.mjs --pi "$(command -v pi)" --check` |

---

## When PI itself updates

This repository is pinned to one PI version, and it depends on roughly 33 lifecycle events plus an
extension API that has moved fast.

```bash
node bin/api-probe.mjs --pi "$(command -v pi)" --check
```

Non-zero means something depended on has been **removed or renamed**. Read the diff before
upgrading; several behaviours documented here were established by reading the shipped code, and a
minor release can change them.

Then re-run the whole ladder: `verify-environment.sh` → `postinstall-verify.sh` →
`bin/pi-check --all` → `/doctor`.

!!! warning "Vendored patches must be re-applied on every version bump"
    `pi-packages/vendor.lock.json` marks all three MCP-adapter patches as mandatory. `PC-21` checks
    the on-disk vendored tree against its recorded per-file hashes, so a lost patch fails the build
    rather than silently reopening the hole. See
    [Third-party components](../reference/third-party.md).

## Related

- [Command reference](cli.md) · [Troubleshooting](troubleshooting.md)
- [Exit codes](../reference/exit-codes.md)
- [`doctor`](../extensions/doctor.md)
