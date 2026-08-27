# Update

`git pull` moves files. `./scripts/update.sh` moves an **install**: it fast-forwards the checkout,
then reconciles what the installer put on your machine against what the repo now contains — new
config files get their symlinks, a lockfile change gets an `npm ci`, and anything it will not decide
for you is printed by name.

```bash
cd ~/PiON
./scripts/update.sh --check    # is there an update, and what would it do? changes nothing
./scripts/update.sh            # report, confirm, apply
```

It is the same contract as [`install.sh`](install.md): ask, then confirm, then write; idempotent;
no `sudo`; no piped shells; every failure carries a `PI-UPDATE-Exx` code, a named cause and an
action.

---

## What it refuses to do

Three refusals, and they are the point of the script rather than edge cases in it.

!!! danger "It never stashes your work"
    A working tree with uncommitted changes to tracked files stops the run with `PI-UPDATE-E07`,
    and the message lists the files. It will not stash, reset or check out over them.

    A stash you did not ask for is a change you will not remember making, and the person who finds
    it three weeks later has no way to tell it apart from work they abandoned. Commit or stash it
    yourself, then re-run.

!!! danger "It only ever fast-forwards"
    If your branch has commits upstream does not have, the run stops with `PI-UPDATE-E11` and lists
    them. Whether they should be rebased or merged is a judgement about your own work, and no
    script is going to make it correctly at 2am.

    ```bash
    git rebase origin/main    # or
    git merge origin/main
    ./scripts/update.sh
    ```

!!! danger "It reports local modifications, it does not resolve them"
    The **generated** config files (`config/models.json`, `config/settings.json`, and the rest of
    the git-ignored set — see [Configuration layout](config-layout.md)) are yours. The installer
    patches them and never resets them, and neither does this script.

    So when an update changes a `*.default.json` **template**, that is a change you did *not* get,
    and update.sh says so by name and moves on:

    ```
    for you to look at — this script will not touch any of these:
      config/settings.default.json was modified upstream — your generated config/settings.json
      is yours and stays untouched. Compare them, or re-run ./scripts/install.sh --reconfigure
    ```

    Merging a new template default into a file you may have hand-edited is a judgement call, not an
    automation. This is the case most likely to bite: it is silent under a plain `git pull`.

An unfinished rebase or merge (`PI-UPDATE-E05`) and an untracked file sitting where upstream adds a
tracked one (`PI-UPDATE-E12`) stop the run for the same reason — both are states where "carry on"
means losing something.

!!! note "`--check` reports all four instead of refusing"
    `--check` writes nothing, so none of these four can hurt it. It prints the condition with its
    code, adds one line saying what an update would do about it, and then gives you the report
    anyway — including the incoming commits and what they touch.

    Refusing there would withhold exactly the information you are asking for before deciding whether
    to clean the tree up. On a diverged branch it also reports against the **merge base**, not
    against `HEAD`, so your own commits are never listed back to you as somebody else's changes.

---

## What it reports before it does anything

Everything below is printed **before** the single confirmation, so one `y` covers a set of changes
you have actually read. `--check` prints the identical report and then exits without touching
anything.

| Section | What it tells you |
|---|---|
| commits | `git log --oneline HEAD..@{u}` — every commit that is about to arrive |
| `config/` | each config path added, removed, modified or renamed, by name |
| `scripts/` | each script that changed — these change how the install itself behaves |
| packages | `package.json` / `package-lock.json`, by name |
| elsewhere | docs, extensions, tests and the rest, as counts |
| PI runtime pin | if `config/pi-release.lock` moves the pinned PI version, the old and new values |
| Node floor | if `engines.node` moves, the old value, the new one, and the version you are running |
| for you to look at | every local-modification and re-pointed-symlink case, in full |
| by hand | new interview questions, a new generated config, a moved PI pin |

---

## What it changes

1. **Fast-forwards the branch.** `git merge --ff-only`. If git refuses, the checkout is untouched.
2. **Reconciles the symlinks** in `~/.pi/agent/` against the
   [install manifest](config-layout.md). A config file that is new in this update gets its link and
   a new manifest row. A link that points somewhere else, or a real file sitting where a link
   belongs, is **reported and left alone** — `./scripts/install.sh --repair` is the command that
   re-points one, and it is yours to run.
3. **Runs `npm ci --ignore-scripts`** — but only if `package-lock.json` actually changed. A
   `package.json` edit alone installs nothing, so it is not a trigger.
4. **Runs `scripts/postinstall-verify.sh`**, the same check `install.sh` runs as *its* last step,
   including the doctor-backed checks. If it reports failures the update has still landed, and the
   exit code is `4`.

!!! note "The symlink table comes from `install.sh` itself"
    update.sh reads the `link_one` lines out of `scripts/install.sh` rather than carrying its own
    copy of the list. A second list of config paths would drift from the first on the very next
    commit that added one, and the drift would be silent — an orphan symlink nobody notices for a
    year. This is the same reasoning as the install manifest: one list, not two.

---

## When it hands you back to the installer

Some things an update cannot do for you, and it names the command instead of guessing:

| It printed | Run |
|---|---|
| the interview gained a new question, naming a section | `./scripts/install.sh --reconfigure --section <name>` |
| a provider fragment changed | `./scripts/install.sh --reconfigure --section providers` |
| a new generated config has no file yet | `./scripts/install.sh --repair` |
| the pinned PI version moved | `./scripts/install.sh --repair` |
| a symlink points somewhere unexpected | `./scripts/install.sh --repair` |

The pinned PI version is worth a second look: update.sh moves the **repository**, never the `pi`
binary. `--repair` is what installs the newly pinned runtime.

---

## Flags

| Flag | Meaning |
|---|---|
| `--check` | print the whole report, change nothing. Exit `0` up to date, `3` an update is waiting. Reports the four blocking conditions rather than refusing on them |
| `--dry-run` | print every action, perform none |
| `--yes`, `--defaults` | never prompt; proceed |
| `--skip-packages` | do not run `npm ci` even if the lockfile changed |
| `--no-verify` | skip the post-update verification step |
| `--prefix DIR` | install root instead of `$HOME` (also `$PI_INSTALL_PREFIX`) |
| `-h`, `--help` | the flag list |

The names are `install.sh`'s names wherever the meaning is the same, deliberately: two scripts you
run from the same directory should not need two vocabularies.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | up to date, or the update completed, or you declined at the confirmation |
| `1` | aborted — a `PI-UPDATE-Exx` code, a cause and an action are printed above the exit |
| `3` | `--check` only: an update is available. Nothing was changed |
| `4` | the update landed, but post-update verification reported failures — read its table |
| `130` | interrupted |

`3` rather than `1` for "an update is waiting" because that is not a failure, and a driver script
has to be able to tell the two apart:

```bash
set -uo pipefail
code=0
./scripts/update.sh --check || code=$?

case $code in
  0) echo "up to date" ;;
  3) ./scripts/update.sh --yes ;;
  *) echo "could not check — exit $code" >&2; exit "$code" ;;
esac
```

Full table, alongside every other script: [Exit codes](../reference/exit-codes.md).

## Related

- [Install](install.md) · [Configuration layout](config-layout.md) · [Verification](../operations/verification.md)
