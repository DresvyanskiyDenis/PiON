# PiON

**PiON — a hardened, portable harness for the [PI coding agent](https://github.com/earendil-works/pi).**

PI ships a good agent loop, a tool set, a TUI and a provider layer. It does not ship a permission
system, a way to say *"run this sub-agent on the delegation model"*, a compaction loop guard, a background
job directory that survives the process, or a headless wrapper that exits non-zero when a turn
actually failed.

This repository is the layer that adds those: **one composed PI extension (38 modules in a fixed load
order) plus a configuration tree symlinked into `~/.pi/agent/`.**

Built and measured against **PI 0.84.4 on macOS (arm64), Node ≥ 22.19.0**. Most of it is
platform-neutral TypeScript; the installer and a handful of shell helpers assume a POSIX shell and
are exercised on macOS.

---

## Install

```bash
git clone https://github.com/DresvyanskiyDenis/PiON.git ~/PiON
cd ~/PiON
./scripts/install.sh
```

Clone it wherever you keep repositories; the installer creates the stable path `~/pi-config` pointing
at your checkout, and every config path is addressed through that. (Do not clone *into* `~/pi-config`
itself — the installer needs to create it as a symlink and aborts with `PI-INSTALL-E12` if a real
directory is already sitting there.)

The installer is interactive and it teaches as it goes: nine sections, each stating what it is about
to configure and why that matters before it asks. It shows every file it will create, modify or
symlink on a review screen and **writes nothing until you confirm** — `Ctrl-C` before that point
changes nothing at all.

```bash
./scripts/install.sh --dry-run        # print every action, perform none
./scripts/install.sh --yes            # accept every default
./scripts/install.sh --reconfigure    # change your mind later — this is the supported way
```

**When it finishes, `pi` works.** Anything that genuinely cannot be automated is printed at the end
as a numbered list of remaining manual steps, never left implicit.

Full detail: [Install](https://dresvyanskiydenis.github.io/PiON/getting-started/install/).

### Update

```bash
./scripts/update.sh --check    # is there an update, and what would it do? changes nothing
./scripts/update.sh            # report, confirm, apply
```

`git pull` moves files; this moves an install. It fast-forwards the checkout, then reconciles the
symlinks in `~/.pi/agent/` against the install manifest, runs `npm ci` only if the lockfile actually
changed, and re-verifies. Same contract as the installer: the whole report first, one confirmation,
a `PI-UPDATE-Exx` code on every failure.

What it will not do is the interesting half. It **refuses to run on a dirty tree** and names the
files rather than stashing them; it **only fast-forwards**, so a diverged branch is a stop with an
explanation and never a rebase it chose for you; and a generated config you have hand-edited whose
template moved upstream is **reported by name and left alone**, because merging that is a judgement
call. Anything it cannot decide ends in the exact `install.sh --reconfigure --section <name>` or
`--repair` command to run.

Full detail: [Update](https://dresvyanskiydenis.github.io/PiON/getting-started/update/).

---

## What you get

| | |
|---|---|
| **Routing by semantic tier** | Agents, scripts and scheduled jobs name a *tier* — `strong`, `light`, `confidential` — never a model id. Repointing a tier is a one-line edit |
| **Fail loud, no failover** | A provider error aborts the turn naming the provider, the model, the error class, the message and the cause chain. Nothing is silently retried onto a different provider or a cheaper model |
| **A permission layer, deliberately narrow** | Six ordered gates over every tool call, of which **two refuse**: catastrophic bash (`rm -rf /`, `mkfs`, `dd` onto a disk) and history-destroying git. The other four — secret paths, privileged commands, the write surface, agent routing — **record and permit**. Nothing prompts. What that costs you is stated plainly rather than implied ([safety model](docs/concepts/safety-model.md)) |
| **MCP behind a default-deny trust gate** | A project's `.mcp.json` is not read until that exact file has been approved by digest, and a project-sourced stdio server is spawned from an empty environment plus an allowlist instead of inheriting every API key you have exported |
| **Sub-agents, teammates, jobs, worktrees** | Depth-limited dispatch with per-provider concurrency, a cross-session background job directory, and `isolation: worktree` that never nests and never `rm -rf`s a dirty tree. An async child that comes back with no output at all gets one automatic follow-up, budgeted on disk so it can never become a loop. Long-lived named teammates carry a delivery obligation welded into the spawn path, but `spawn` **refuses out of the box** — the host has to supply a model-resolving spawner first ([why](docs/extensions/teammates.md)) |
| **Sessions that can talk to each other** | `message_agent` addresses another *running* session by name over an on-disk directory, and wakes it — peers that never spawned each other, not just a lead and its children. Fire-and-forget, replies come back through the same tool ([message-agent](docs/extensions/message-agent.md)) |
| **Honest context accounting** | A `/context` command that separates the fixed preamble from the compactable dialogue, a compaction loop guard, and the rule the whole thing rests on: `contextWindow = min(200000, what the endpoint actually serves)` |
| **A fail-closed headless wrapper** | `pi -p --mode json` exits `0` on a failed turn. `bin/pi-run` parses the stream and exits `20`/`21`/`22`/`23`/`24` when the run failed, was truncated, drifted, looped or was aborted |
| **Structural gates before the tests** | `bin/pi-gate` asks what a test suite cannot: is the *way* this change was arrived at healthy. Four cheap history-and-diff checks — a fix-streak on one file, a near-duplicate module, a wave of new top-level modules with no sign-off, a job with no way to run on a subset. Warn-only by default, blocking on `--block` ([structural gates](docs/operations/structural-gates.md)) |

Plus declarative YAML hooks (including hard project constraints enforced at the tool call, so a
`NEVER` written in a plan file is refused rather than merely hoped for), task-list nudges, session digests, a searchable session index, a quota
meter, `@import` expansion in instruction files, oversized tool-result externalisation with a
re-expand handle, automatic session titling, and a `/doctor` command that reports which modules
loaded and which are expected-but-absent.

---

## What it deliberately does not ship

**No skill is loaded by default.** A skill is prose plus scripts, and prose is where somebody's
employer, client or private workflow leaks out — so the loaded roster ships empty and the *machinery*
is what ships instead: skill discovery, the `PI_SKILL_DIR_*` environment shim, the `allowed-tools`
portability lint, and a documented precedence order. Yours go in the clone's git-ignored `skills/`,
which the installer links to the one root `settings.json` searches.

One worked example sits in [`examples/skills/`](examples/skills/), tracked but outside every search
path: copy it in to use it. It is there because "write your own" is a thin answer to "what does a
good one look like".

**No guardrail is armed by default.** `~/.pi/agent/hooks.yaml` is linked to `config/hooks-off.yaml`
— a valid hooks file with an empty rule list — so a fresh install blocks nothing. The sandbox ships
`enabled: false` and the global constraint list ships empty for the same reason: a gate nobody chose
does not protect a write path, it breaks one silently, and the first thing a surprising refusal
teaches is to disable the whole layer. `./scripts/install.sh --with-guardrails` arms
`config/hooks.yaml` and the installer remembers the choice; `ln -sf ~/pi-config/config/hooks-off.yaml
~/.pi/agent/hooks.yaml` puts it back. `bin/pi-check --doctor` prints which gate is live. The rules
that then apply are deliberately three: one refusal for force-pushing `main`, and two that arm your
own `constraints.json`.

**No MCP server definitions either**, for the same reason: a server list is as personal as a password
manager. The machinery ships — the vendored adapter, the project trust gate, the `mcp-stdio-guard`
environment-minimising wrapper — and the installer offers two public servers (`context7`,
`playwright`) at install time, defaulting to neither.

Adding your own is a documented, first-class path:
[skills](https://dresvyanskiydenis.github.io/PiON/extending/skills/) ·
[MCP servers](https://dresvyanskiydenis.github.io/PiON/extending/mcp-servers/) ·
[sub-agents](https://dresvyanskiydenis.github.io/PiON/extending/subagents/) ·
[providers](https://dresvyanskiydenis.github.io/PiON/extending/providers/).

**No provider failover**, on purpose. **No claim that the egress classes are a network boundary** —
they are a declarative control that refuses a dispatch, and nothing here intercepts a socket. The
rest of the honest list is in
[Known limitations](https://dresvyanskiydenis.github.io/PiON/limitations/).

---

## Layout

```text
extensions/        38 modules + index.ts, the composition root that fixes their load order
config/            everything the agent reads at runtime; *.default.json are the tracked templates
config/bin/        helper commands symlinked onto your PATH (pi-tier, pi-mcp-approve, …)
config/providers/  one fragment per provider; the installer composes models.json from these
agents/            sub-agent definitions (12 ship; add your own alongside)
bin/               pi-run, pi-check, pi-gate, and the 29 repository rules pi-check enforces
scripts/           install.sh, update.sh, uninstall.sh, verification scripts
pi-packages/       vendored third-party source, patched and pinned by digest
docs/              the MkDocs site
wiki/              the GitHub wiki source, pushed to a separate remote
```

Ten config files are **generated** by the installer and git-ignored — `models`, `routing`, `mcp`,
`settings`, `guard`, `trusted-roots`, `path-defaults`, `web`, `web-search`, `quota`. A fresh clone
carries only the `config/<name>.default.json` half. Editing a generated file is normal and survives a
re-run, because the installer patches rather than resets; an edit that must survive a **fresh clone**
belongs in the template.

---

## Documentation

| | |
|---|---|
| **[Documentation site](https://dresvyanskiydenis.github.io/PiON/)** | Structured reference: installation, every configuration key, all 38 modules, the safety model, exit codes. Lives in `docs/`, changes with the code, and a broken link fails CI |
| **[Wiki](https://github.com/DresvyanskiyDenis/PiON/wiki)** | Fast operational material: FAQ, task recipes, troubleshooting, a provider cheat sheet, release notes. Edited without a pull request |

The single highest-value page is the
[configuration reference](https://dresvyanskiydenis.github.io/PiON/configuration/) — what to change after
installation to make the agent behave differently.

Build the site locally:

```bash
uv run --with-requirements requirements-docs.txt mkdocs serve
```

---

## Verifying an install

```bash
~/pi-config/bin/pi-check --all      # 32 repository invariants
~/pi-config/bin/pi-gate             # four structural gates over the branch, warn-only
./scripts/postinstall-verify.sh     # the install itself
/doctor                             # inside pi: which modules loaded, which are missing
```

`bin/pi-check` is the interesting one. It refuses a model id that is not provider-qualified, a tier
bound to a provider that is not present, any `fallback` / `failover` key, a secret-shaped literal in
a tracked file, an unreplaced `<PLACEHOLDER>`, a vendored tree whose bytes no longer match their
recorded digests, and seventeen other things.

`bin/pi-gate` asks the other question — not whether the tree is consistent, but whether the branch
that produced it looks healthy: consecutive `fix:` commits on one file, a new module that differs
from an existing one by a single token, four or more new top-level modules with no recorded
sign-off, a job that advertises no way to run on less than everything. It warns and exits `0`
unless you pass `--block`; `npm run check` is typecheck, gate, then the suite. What each gate
cannot see is written down beside what it can, in
[structural gates](docs/operations/structural-gates.md).

---

## Requirements

- **Node ≥ 22.19.0** — the extensions are TypeScript executed by Node's strip-only type loader, so
  there is no build step and no emitted JavaScript.
- **PI 0.84.4** — the installer can install it for you (`--mode binary` or `--mode npm`).
- A POSIX shell. `jq` and `sqlite3` for some helpers; the installer checks and tells you.
- At least one model provider you have credentials for. Which one is your choice: the installer
  offers the providers in `config/providers/` and sets the defaults from whichever you select.

---

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md); the short version is
that `bin/pi-check --all` and `npm test` must pass, a documentation change ships in the same pull
request as the behaviour it describes, and a new invariant belongs in `bin/rules/` rather than in
prose.

---

## Licence and attribution

**MIT.** See [`LICENSE`](LICENSE); `package.json` declares the same. Use it, fork it, ship it —
keep the copyright notice.

Third-party components carry their own licences, which the above does not affect. Every one is
catalogued — package, version, licence, author, upstream — in
[Third-party components](https://dresvyanskiydenis.github.io/PiON/reference/third-party/). Two worth knowing
up front:

- **PI** itself (`earendil-works/pi`, MIT, Mario Zechner) is a separate project. This repository
  configures and extends it; it neither forks nor redistributes it.
- **`pi-packages/pi-mcp-adapter/`** is third-party source (MIT, Nico Bailon) *vendored deliberately*
  and carrying a local patch that changes upstream default behaviour. What the patch does, and why it
  cannot live outside the vendor boundary, are on that same page.
