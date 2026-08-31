# Install

One script. It asks questions, shows you everything it is about to do, and does nothing until you
confirm.

```bash
git clone https://github.com/DresvyanskiyDenis/PiON.git ~/PiON
cd ~/PiON
./scripts/install.sh
```

Clone it wherever you keep repositories. The installer creates `~/pi-config` as a **symlink** to your
checkout and addresses every config path through it, so the checkout can live anywhere and a
`git pull` updates the live agent.

!!! warning "Do not clone into `~/pi-config` itself"
    That path has to be free for the installer to create the symlink. A real directory sitting there
    stops the install with `PI-INSTALL-E12`, which tells you to move it aside and re-run.

**The contract: when the script finishes, `pi` works.** Not "works once you also export a variable",
not "works after you edit three JSON files". Anything that genuinely cannot be automated is printed
at the end as a numbered list of remaining manual steps — never left implicit.

Check [Prerequisites](prerequisites.md) first if you have not.

---

## What it guarantees

These are properties the script is written to have, not aspirations:

| Property | What it means for you |
|---|---|
| **Ask, then confirm, then write** | The whole interview happens first. A review screen lists every file that will be created, modified or symlinked, and every line appended to a shell rc. **Ctrl-C before that point changes nothing at all** |
| **Idempotent** | Every step reads the desired end state first and prints `ok` when it already holds. A second run on a converged machine changes 0 steps |
| **Re-runnable** | An existing install is detected and you are offered reconfigure / one section / repair / leave alone |
| **Leaves no orphans** | Every path it creates is appended to an install manifest that `uninstall.sh` reads back. One list, not two that drift |
| **No admin** | Writes only under the prefix (`$HOME` by default). Never `sudo` |
| **No secret in git** | Credentials go to `~/.pi/secrets.env` (`0600`) or the macOS Keychain. Config files carry only `$VAR` references, re-checked against the generated files before the install may finish |
| **Fails loudly** | Every exit path has a `PI-INSTALL-Exx` code, a named cause and an action. No bare `exit 1`, no silent skip |
| **No piped shells** | Never `curl … \| sh`. `npm` is always `--ignore-scripts` |

It is also a *teaching* installer: each section states what it is about to configure and why that
matters, in one plain sentence, before asking.

---

## Look before you leap

```bash
./scripts/install.sh --dry-run
```

Prints every action and performs none. Worth doing once even if you intend to accept every default.

To try it without touching your real setup:

```bash
./scripts/install.sh --prefix /tmp/pi-test --yes
```

!!! warning "`--prefix` isolates the install, not the checkout"

    `--prefix` moves `bin/`, `.pi/` and the whole runtime tree. It does **not** move the generated
    config: `config/models.json`, `config/routing.json`, `config/settings.json` and their siblings
    are always written into the clone you ran the script from, next to the `*.default.json` they
    are generated from, because the live config is a symlink back into the repo by design.

    So a throwaway install overwrites the real one's generated config, and the previous contents
    are left beside them as `*.bak.<timestamp>`. They are gitignored, so nothing can reach a
    commit — but a repo whose test suite reads `config/routing.json` will start failing against
    the throwaway's answers. After a test install, from the clone:

    ```bash
    rm -f $(git status --porcelain --ignored config/ | awk '$1=="!!"{print $2}') config/*.bak.*
    ```

    Then re-run your real install, or `./scripts/install.sh --repair`.

---

## The nine sections

| # | Section | Decides |
|---|---|---|
| 1 | **Checking your machine** | Nothing is written. It confirms the tools the rest of the install needs |
| 2 | **Looking for an existing install** | Re-running is normal. Nothing is overwritten without asking |
| 3 | **Providers and credentials** | Where the models come from. Pick the ones you have access to; the rest can be added later by re-running |
| 4 | **Tier bindings** | Your agents and skills ask for a *tier*, never a model id. This is where a tier is pointed at a real model |
| 5 | **Agent behaviour** | Which model PI opens with, how hard it thinks by default, how it looks. All changeable later inside PI |
| 6 | **Safety posture** | What PI may do **without asking you first** — the one setting nobody should accept blindly |
| 7 | **Tools and integrations** | Web search (self-hosted SearXNG, a Tavily/Brave/Exa key, or none — with `none`, `web_fetch` still works keyless via Jina Reader), language servers, quota metering, and where your own skills will live. Every one optional |
| 8 | **MCP servers** | Which MCP servers, if any, are declared. The default is none |
| 9 | **Shell integration** | The most common reason an install "does not work": the config is perfect and the shell never loads it |

!!! danger "Section 6 is the one to actually read"
    A small, fixed set of catastrophic command shapes — credential-file reads, `rm -rf /`, a
    disk-format command, a force-push onto a protected branch, and a handful of others — is
    refused outright, in code, and there is nothing here to configure for that: no allowlist, no
    unattended-execution mode. Everything else runs, headless included, with no prompt.

    The only thing this section asks is which branches count as "protected."
    [`guard.json`](../configuration/guard.md) spells out exactly what still blocks and what does not.

### Section 7 also asks where your skills go

This repository loads **zero skills** — only the machinery that finds them, plus one worked example
under `examples/skills/` that no search path reaches. So the only skill question
at install time is where yours will live, and the answer offered is `skills/` inside the checkout:
git-ignored, and symlinked to `~/.pi/agent/skills`, which is the one search path `settings.json`
names. Say yes and the directory is created empty. Writing a skill can then never turn into
committing one.

How to actually write one: [Writing a skill](../extending/skills.md).

### Section 8: MCP servers

An MCP server is third-party code started on your machine and reached with your credentials, so this
harness declares **none** by default and the step defaults to none.

If `config/mcp.json` already exists, the step stands down entirely and says so — that file is yours,
possibly hand-written from `config/mcp.example.json`, and the installer will not edit it.

Otherwise it offers exactly two, because both are public services that explain themselves:

| | Server | Transport | Needs |
|---|---|---|---|
| 1 | `context7` | HTTP | a `CONTEXT7_API_KEY`, which you are then offered the usual credential choices for |
| 2 | `playwright` | stdio, wrapped in `mcp-stdio-guard` | nothing at install time; it downloads its browsers into `~/.cache/ms-playwright` on first use |

You answer with numbers, comma-separated, or blank for none. Anything you pick is written to the
generated `config/mcp.json`.

Two things the step does regardless of your answer:

- **`settings.hostConfigDiscovery` is asserted to `"off"`**, whatever the template said. PI otherwise
  picks up MCP servers that some other tool configured on this machine.
- **`playwright` is declared through `mcp-stdio-guard`**, with `MCP_STDIO_EXTRA_ENV` naming the one
  variable it is allowed to keep (`PLAYWRIGHT_BROWSERS_PATH`). The child gets an emptied environment
  plus a baseline, not every API key you have exported.

Adding servers later is a hand-edit of `config/mcp.json` (copy an entry from
`config/mcp.example.json`), or a re-run with `--section tools`, which covers this step too. See
[Adding an MCP server](../extending/mcp-servers.md).

---

## What it actually writes

### Generated config

Eleven config files are **generated**: produced from a tracked `*.default.json` template plus, where
relevant, `config/providers/*.json` and your answers.

```text
models.json  routing.json  mcp.json  settings.json  guard.json
trusted-roots.json  path-defaults.json  web.json  web-search.json  quota.json
subagent.json
```

The template is read, never written. The generated file is yours — including any hand edit, because
a re-run **patches** an existing generated file rather than resetting it to the template. That is
also what makes a second run report zero changes.

!!! note "Why the split exists"
    Before it, these files were tracked *and* patched in place, so every install dirtied the working
    tree and whatever was on that machine — a workspace host, a home directory, a chosen default
    model — became the next commit in anybody's fork.

**An edit that must survive a fresh clone belongs in the template.** See
[Configuration reference](../configuration/index.md).

### Symlinks, not copies

```text
~/pi-config            -> your clone           (a stable path everything else uses)
~/.pi/agent/*          -> files in the clone   (settings, models, routing, guard, hooks, …)
~/bin/pi-tier          -> config/bin/pi-tier   (and every other helper in config/bin/)
~/bin/pi-run           -> bin/pi-run
```

Editing a file in the repository changes the live agent immediately, and `git pull` updates it.
**Nothing is copied.**

!!! warning "`extensions/` is deliberately NOT linked"
    PI discovers `<agentDir>/extensions/*.ts` and `<agentDir>/extensions/<dir>/index.ts`, and would
    load every module as a separate extension in `readdir` order — breaking the fixed load order
    that puts `guard` before `bash`, and failing every module that has no default export.

    `config/settings.json` names one file, `extensions/index.ts`, explicitly instead.

### The PI runtime itself

`--mode binary` downloads the release archive for your platform and unpacks it whole. It is a tree,
not a bare executable — the binary loads native modules, wasm and a bundled `node_modules` from
beside itself — so what goes on `PATH` is a symlink into that tree:

```text
~/.local/share/pi-config/runtime/<version>/pi/pi   the unpacked release (tens of MB)
~/bin/pi  ->  that file                            what your shell finds
```

!!! note "Why not `~/.local/pi/`, where PI installs itself"
    That path belongs to PI's own installer — `pi update` and the upstream one-liner write
    `~/bin/pi -> ~/.local/pi/<version>/pi/pi`. Unpacking into it would mean writing over a tree
    another installer owns, and recording it in the manifest as ours — and a manifest row is what
    lets `uninstall.sh` delete a directory recursively. A `pi` you installed yourself would go out
    with a PiON uninstall. Separate namespaces make that impossible rather than merely unlikely.

`--mode npm` installs the package globally instead and points `~/bin/pi` at npm's own copy; nothing
is unpacked under the prefix.

### What is never linked

`auth.json`, `trust.json`, `sessions/` and `models-store.json` stay PI-owned. The installer
**aborts** (`PI-INSTALL-E19`) if it finds any of them symlinked into the repository: credentials,
trust decisions and transcripts must never live in git.

### Credentials

Per provider, you choose:

| Choice | Result |
|---|---|
| already available | the variable is exported in your environment; nothing is stored |
| secrets file | you are asked for the value; it is written to `~/.pi/secrets.env` (`0600`) |
| Keychain (macOS) | stored under a named service; the config references it by command |
| later | deferred, and listed as a numbered manual step at the end |

The repository never sees a secret value. `bin/pi-check`'s `PC-06` greps the tracked tree for
key-shaped strings and fails the build on one.

---

## Unattended installs

Every flag drives the identical code path — there is no separate "quiet mode" that skips steps.

```bash
./scripts/install.sh --yes                        # accept every default, never prompt
./scripts/install.sh --express                    # providers + safety only, defaults for the rest
./scripts/install.sh --answers my.conf --yes      # from a saved answer file
./scripts/install.sh --providers a,b              # preselect providers, skip the picker
./scripts/install.sh --tier light=acme/model-1    # preset one tier binding (repeatable)
```

Each run saves its answers, so **a second machine can be made identical** by copying that file and
passing `--answers`. The path is printed in the final summary.

Other useful flags:

| Flag | Effect |
|---|---|
| `--mode auto\|binary\|npm` | how PI itself is installed |
| `--offline [--offline-dir D]` | no network; artifacts pre-staged in `D` |
| `--skip-runtime` | do not touch the PI binary; configure only |
| `--skip-packages` | do not `npm install` the packaged extensions |
| `--with-guardrails` | link `config/hooks.yaml`, whose rules can **block** a tool call. Off by default — see [Guardrails are off by default](#guardrails-are-off-by-default) |
| `--no-shell` | do not modify any shell rc file |
| `--no-verify` | skip the post-install verification step |
| `--prefix DIR` | install root instead of `$HOME`. Does **not** relocate the generated `config/*.json` — see [the warning under "Look before you leap"](#look-before-you-leap) |

---

## Guardrails are off by default

The installer links `~/.pi/agent/hooks.yaml` to **`config/hooks-off.yaml`**, a valid hooks file
carrying an empty rule list. A fresh install therefore blocks nothing: no hook rule is armed, the
sandbox ships `enabled: false`, and `config/constraints.json` ships an empty list. The machinery is
wired; the policy is yours.

```bash
./scripts/install.sh --with-guardrails                            # arm config/hooks.yaml
ln -sf ~/pi-config/config/hooks-off.yaml ~/.pi/agent/hooks.yaml   # back off, by hand
bin/pi-check --doctor                                             # which gate is live right now
```

The choice is saved with your other answers, so `--repair` and `--reconfigure` keep it rather than
resetting it, and `./scripts/update.sh` reports which gate it found and re-points neither.

!!! danger "What arming them means: hooks fail closed"
    A rule that cannot be evaluated — a bad regex, an action that throws, a `run` script that is
    missing or times out — **blocks** the tool call rather than permitting it. That is correct for a
    guardrail and it is also why this is opt-in: an armed layer whose `run` script is not installed
    does not degrade into "no guardrail", it kills `edit` and `write` for the whole session. Read
    [Writing a hook](../extending/hooks.md) before you turn it on, and re-run
    `./scripts/install.sh` after any change that moves a hook script.

!!! note "Why off is a file, not a deletion"
    Deleting `~/.pi/agent/hooks.yaml` reaches the same runtime state, and is indistinguishable from
    a machine where the install never ran. The empty gate still reads as a decision six months
    later, which is the whole point of it. Full reasoning, and what stays on regardless (the guard's
    two refusing gates), in [Turning guardrails off](../extending/hooks.md#turning-guardrails-off).

---

## Reconfiguring later

**Re-running the installer is the supported way to change configuration.** It is not a reinstall.

```bash
./scripts/install.sh --reconfigure           # re-run the interview over an existing install
./scripts/install.sh --section providers     # just one section
./scripts/install.sh --repair                # re-link and re-verify, ask nothing
```

Adding a provider six months from now is a re-run, not a hand-edit. Sections:
`providers` · `tiers` · `agent` · `safety` · `tools` · `shell` · `maintenance`.

---

## When it finishes

The summary tells you what you have, what was skipped, what was backed up, and — numbered — what is
still yours to do by hand.

Then:

```bash
exec $SHELL -l          # so PATH and the environment file are loaded
pi                      # start the agent
```

!!! note "A missing provider credential does not stop PI from starting"
    It reports which provider is unconfigured, and every tier bound to a provider you *did*
    configure keeps working. A request that needs the missing one **fails loudly, naming it**.

    Nothing is silently sent somewhere else. There is no failover in this harness, anywhere — see
    [`onProviderError`](../configuration/routing.md#onprovidererror).

The installer runs `scripts/postinstall-verify.sh` itself as its last step. If that table shows
failures, the install still completed — read the table. See [Verification](../operations/verification.md).

Next: [First run](first-run.md).

---

## Updating later

`./scripts/update.sh` fast-forwards the checkout and then reconciles the install against it: new
config files get their symlinks, a changed lockfile gets an `npm ci`, and a template you have
diverged from is named rather than overwritten. It refuses to run on a dirty tree and it never
merges or rebases for you.

```bash
./scripts/update.sh --check    # is there an update, and what would it do?
./scripts/update.sh            # report, confirm, apply
```

It hands you back here for anything an update cannot decide — a new interview question, a changed
provider fragment, a moved PI pin all end in `./scripts/install.sh --reconfigure` or `--repair`, and
update.sh prints the exact command. See [Update](update.md).

---

## Uninstalling

```bash
./scripts/uninstall.sh                 # remove the agent, keep sessions and credentials
./scripts/uninstall.sh --dry-run       # print every action, change nothing
./scripts/uninstall.sh --purge         # also remove ~/.pi entirely       (asks first)
./scripts/uninstall.sh --purge-state   # also remove the runtime state dir (asks first)
```

To move an install forward rather than take it out, see [Update](update.md) — it reads the same
manifest, and adds to it rather than removing from it.

It reads the install manifest back, so it removes **only what the installer created**. A foreign
file or symlink sitting at one of those paths is left alone and reported, not deleted.

Plain `./scripts/uninstall.sh` never deletes credentials, trust decisions or session transcripts.
`--purge` and `--purge-state` are the only paths that can, and both confirm first unless you pass
`--yes`.

The state directory `--purge-state` removes (`$XDG_STATE_HOME/pi-config`, default
`~/.local/state/pi-config`) holds the digest queue, the job store, worktree bookkeeping,
compaction-loop state, per-session scratch directories and locks — things the installer never
created, which is why they are kept by default.

## Related

- [Prerequisites](prerequisites.md) · [First run](first-run.md) · [Update](update.md) · [Configuration layout](config-layout.md)
- [Configuration reference](../configuration/index.md) — what to change afterwards
- [Verification](../operations/verification.md) · [Troubleshooting](../operations/troubleshooting.md)
