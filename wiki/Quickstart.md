# Quickstart

**Re-running the installer is a supported operation, not a reinstall.** It detects the install it
made, loads the answers you gave last time, and asks again with each of them pre-filled — Enter
keeps one. Nothing is replaced without asking, everything it does replace is backed up, and every
path it creates is written to a manifest that `uninstall.sh` reads back.

So: you do not hand-edit your way out of a decision you regret. You re-run.

---

## First install

```bash
git clone https://github.com/DresvyanskiyDenis/PiON.git
cd PiON && ./scripts/install.sh
```

The interview asks how much you want to be asked (full, about five minutes — or express, about
two), then walks the sections below. Nothing is written until the review screen, which prints every
action first. The final summary names the answer file it saved; pass it back with `--answers` and
`--yes` to make a second machine identical.

---

## After install: the four modes

| What you want | Command |
|---|---|
| The full interview again, your old answers pre-filled | `./scripts/install.sh --reconfigure` |
| One section only, everything else untouched | `./scripts/install.sh --section <name>` |
| Re-link and re-verify, ask nothing | `./scripts/install.sh --repair` |
| See what would happen, change nothing | `./scripts/install.sh --dry-run` |

Run `./scripts/install.sh` with no flags on an existing install and it offers the same four as a
menu, defaulting to **3**:

```
   What should this run do?
     1) reconfigure everything  — the full interview, your answers pre-filled
     2) reconfigure one section — providers, tiers, agent, safety, tools or shell
     3) repair                  — re-link and re-verify, ask nothing
     4) leave it alone          — exit now, change nothing
   choice [3]:
```

A **non-interactive** re-run — cron, CI, a pipe — has no terminal to answer the menu, so it is
treated as repair and regenerate. It never silently re-interviews you.

---

## The six sections

`--section` takes exactly one of these names.

| Section | What it re-asks |
|---|---|
| `providers` | Which providers you use, and whatever each provider fragment declares: base URL, the *name* of the environment variable holding the credential, egress, model ids, context windows and per-token price |
| `tiers` | Which model each tier (`strong`, `light`, `confidential`) resolves to. Your agents and skills ask for a tier, never for a model id |
| `agent` | Default provider and model, default thinking level, theme, external editor, TUI mode |
| `safety` | The safety posture — chiefly which branches count as protected. The catastrophic shapes are refused in code and are not configurable |
| `tools` | Web search backend, language servers, quota metering, and the MCP servers you opt into |
| `shell` | The `pi-config` block appended to your shell rc: `PATH`, the environment file, proxy variables |

The credential *values* are asked once, later in the run, and go to `~/.pi/secrets.env` (mode
`0600`) or the macOS Keychain — never into a config file, never into git.

---

## Common recipes

| I want to… | Run |
|---|---|
| Add a provider I now have access to | `./scripts/install.sh --section providers` |
| Point a tier at a different model | `./scripts/install.sh --section tiers` |
| Add or remove MCP tools | `./scripts/install.sh --section tools` |
| Pick the changes up after `git pull` | `./scripts/install.sh --repair` |
| Install fast and go deeper later | choose **2) express** at "How much do you want to be asked?" |
| Change a generated config by hand instead | edit `config/<name>.json` — it survives a re-run |

Express asks for providers, credentials and the safety posture only, and defaults everything else.
It is not a lesser install: re-run with `--reconfigure` whenever you want the rest of the questions.

`./scripts/update.sh` tells you when a re-run is *needed* — a new interview question, a changed
provider fragment, a template that moved — and prints the exact command for each.

> **One thing a re-run does not do.** Ten config files are generated and git-ignored; the tracked
> templates are `config/<name>.default.json`. A hand-edit to a generated file survives every re-run
> (the installer patches, it does not reset) but not a fresh clone — so anything you want to keep
> forever belongs in the matching template too.

---

## Check it worked

```bash
./scripts/postinstall-verify.sh        # the install itself
~/pi-config/bin/pi-check --all         # the repository invariants
```

Inside PI, `/doctor` reports which modules loaded and which were expected but absent.

---

See also: [[Cookbook]] for the deeper recipes, [[FAQ]] for "how do I change something after
installing?", [[Troubleshooting]] for when a run goes wrong, and [[Provider Cheat Sheet]] for what
each provider needs. The complete installer reference — every flag, every exit code — is
[`docs/getting-started/install.md`](https://dresvyanskiydenis.github.io/PiON/getting-started/install/).
