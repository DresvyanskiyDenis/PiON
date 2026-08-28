#!/usr/bin/env bash
# update.sh — pull this checkout forward, and say what that changed about your machine.
#
# PiON — a hardened, portable harness for the PI coding agent.
#   https://dresvyanskiydenis.github.io/PiON/
#
# The contract: `git pull` moves files; this script moves an *install*. It fast-forwards the
# checkout, then reconciles what install.sh put on the machine against what the repo now
# contains — new config files get their symlinks, a lockfile change gets an `npm ci`, and
# anything it will not decide for you is printed by name.
#
# Properties this script is required to have, and how each is achieved. They are install.sh's
# properties, deliberately: this is the second half of the same tool.
#   * ask, then confirm, then write — the whole report (incoming commits, what they touch, what
#                          it will do about it) is printed first, and one confirmation covers it.
#                          Ctrl-C before that point changes nothing at all.
#   * never stashes      — a dirty working tree or an unfinished rebase/merge is a refusal that
#                          names the files, not something to tidy away. Your work is yours.
#   * fast-forward only  — a diverged branch stops the run and explains. Whether to rebase or
#                          merge your own commits is your call, and no script is going to make
#                          it for you at 2am.
#   * unattended capable — --yes and --check drive the identical code path with zero prompts.
#   * idempotent         — on a converged machine it reports 0 changes and exits 0.
#   * leaves no orphans  — every path it creates is appended to the SAME install manifest that
#                          install.sh writes and uninstall.sh reads back. One list, still not two.
#   * reports, never resolves — a config file you hand-edited that upstream also changed is
#                          named and left alone. Merging your edits is a judgement call.
#   * no admin           — writes only under the prefix ($HOME by default); never sudo.
#   * fails loudly       — every exit path has a PI-UPDATE-Exx code, a named cause and an action.
#                          There is no bare `exit 1` and no silent skip.
#   * no piped shells    — npm is always --ignore-scripts.
#   * clears the reminder — an applied update removes <agent-dir>/update-pending, the note
#                          scripts/auto-update-check.sh writes and extensions/auto-update reads at
#                          session start. Applying an update and still being told about it is the
#                          fastest way to teach someone to ignore the message.
#
# Usage:
#   ./scripts/update.sh                 # fetch, report, confirm, update
#   ./scripts/update.sh --check         # is there an update, and what would it do? changes nothing
#   ./scripts/update.sh --dry-run       # print every action, perform none
#   ./scripts/update.sh --yes           # unattended: no confirmation prompt
#
# Flags:
#   --check                   report availability and the full plan, change nothing.
#                             Exit 0 = up to date, 3 = an update is waiting.
#                             It writes nothing, so a dirty tree, an unfinished rebase, a diverged
#                             branch, an untracked-file collision or an ignored file upstream has
#                             started tracking are REPORTED here rather than
#                             refused — withholding the report is not a safety property, and it is
#                             the information you want before deciding to clean up.
#   --dry-run                 print every action, perform none
#   --yes | --defaults        never prompt; proceed with the update
#   --skip-packages           do not run npm ci even if the lockfile changed
#   --no-verify               skip the post-update verification step
#   --prefix DIR              install root instead of $HOME (also $PI_INSTALL_PREFIX)
#   -h | --help
#
# Exit codes:
#   0    up to date, or the update completed, or you declined at the confirmation
#   1    aborted — a PI-UPDATE-Exx code, a cause and an action are printed above the exit
#   3    --check only: an update is available. Nothing was changed
#   4    the update landed, but post-update verification reported failures — read its table
#   130  interrupted (Ctrl-C / SIGTERM)
#
# Docs: docs/getting-started/update.md
#       https://dresvyanskiydenis.github.io/PiON/getting-started/update/

set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

CHECK_ONLY=0
DRY_RUN=0
ASSUME_YES=0
SKIP_PACKAGES=0
RUN_VERIFY=1
PREFIX="${PI_INSTALL_PREFIX:-$HOME}"

CHANGED=0
FINAL_EXIT=0
APPLYING=0
MANUAL_TODO=""
REPORTED=""

# ============================================================================= presentation ===
# Identical to install.sh's block, on purpose: the two scripts are read one after the other, and
# a second visual vocabulary would make the same symbol mean two things.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_OK=$'\033[32m'; C_CH=$'\033[33m'; C_ER=$'\033[31m'; C_B=$'\033[1m'
  C_D=$'\033[2m';   C_C=$'\033[36m'; C_0=$'\033[0m'
else
  C_OK=""; C_CH=""; C_ER=""; C_B=""; C_D=""; C_C=""; C_0=""
fi
S_OK="✔"; S_CH="+"; S_WARN="!"; S_INFO="·"

SECTION_N=0
SECTIONS_TOTAL=6
section() { # section <title> <one-line why this matters>
  SECTION_N=$((SECTION_N + 1))
  printf '\n%s%s Step %d of %d — %s %s\n' "$C_C" "$C_B" "$SECTION_N" "$SECTIONS_TOTAL" "$1" "$C_0"
  printf '%s%s%s\n' "$C_D" "$2" "$C_0"
}
step()    { printf '\n%s== %s%s\n' "$C_B" "$*" "$C_0"; }
ok()      { printf '   %s%s%s  %s\n' "$C_OK" "$S_OK" "$C_0" "$*"; }
changed() { printf '   %s%s%s  %s\n' "$C_CH" "$S_CH" "$C_0" "$*"; CHANGED=$((CHANGED + 1)); }
warn()    { printf '   %s%s%s  %s\n' "$C_CH" "$S_WARN" "$C_0" "$*" >&2; }
info()    { printf '   %s%s %s%s\n' "$C_D" "$S_INFO" "$*" "$C_0"; }
die() {
  # die <CODE> <cause> <what to do about it>
  printf '\n%sFAILED %s%s\n  cause:  %s\n  action: %s\n\n' "$C_ER" "$1" "$C_0" "$2" "$3" >&2
  exit 1
}
# Commands are passed as pre-quoted single strings on purpose, so --dry-run echoes exactly what
# a real run would perform.
# shellcheck disable=SC2294
run() { if [ "$DRY_RUN" = 1 ]; then printf '   %sdry-run%s %s\n' "$C_D" "$C_0" "$*"; else eval "$@"; fi; }
todo_add() { MANUAL_TODO="$MANUAL_TODO
$*"; }
# Something the user must look at, which this script deliberately will not act on.
report_add() { REPORTED="$REPORTED
     $*"; }

# Prints the header block above: everything from the line after the shebang up to the first line
# that is not a comment. Deliberately NOT a line range. The range this replaces was wrong twice in
# one day — it stopped at exit code 4, so `--help` printed the exit-code table with 130 missing and
# no link to the docs, and then adding one line to the --check note moved the end again. A help
# text whose correctness depends on someone remembering to renumber it is a help text that will be
# wrong, and being wrong about the exit codes is being wrong about the thing --help is for.
usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"; exit 0; }

# ============================================================================ argument parse ===
while [ $# -gt 0 ]; do
  case "$1" in
    --check)             CHECK_ONLY=1; shift ;;
    --dry-run)           DRY_RUN=1; shift ;;
    --yes|--defaults)    ASSUME_YES=1; shift ;;
    --skip-packages)     SKIP_PACKAGES=1; shift ;;
    --no-verify)         RUN_VERIFY=0; shift ;;
    --prefix)            PREFIX="${2:?--prefix needs a directory}"; shift 2 ;;
    -h|--help)           usage ;;
    *) die "PI-UPDATE-E01" "unknown argument '$1'" \
           "run ./scripts/update.sh --help for the flag list" ;;
  esac
done

# --check is a report. Routing it through the same DRY_RUN switch the rest of the script already
# honours means there is one no-write code path to get right, not two.
[ "$CHECK_ONLY" = 0 ] || DRY_RUN=1

STABLE_LINK="$PREFIX/pi-config"
PI_HOME="$PREFIX/.pi"
if [ "$PREFIX" = "$HOME" ]; then AGENT_DIR="${PI_CODING_AGENT_DIR:-$PI_HOME/agent}"
else AGENT_DIR="$PI_HOME/agent"; fi
MANIFEST="$AGENT_DIR/install-manifest.tsv"
ANSWERS_FILE="$AGENT_DIR/install-answers.conf"
SECRETS_FILE="$PI_HOME/secrets.env"

INTERACTIVE=1
[ "$ASSUME_YES" = 0 ] || INTERACTIVE=0
[ "$CHECK_ONLY" = 0 ] || INTERACTIVE=0
{ [ -r /dev/tty ] && [ -t 0 ]; } || INTERACTIVE=0

# ============================================================================ scratch + traps ===
# Never /tmp: $TMPDIR is per-user on macOS, and mktemp -d keeps this run out of any other run's way.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pi-update.XXXXXX")" || \
  die "PI-UPDATE-E02" "cannot create a scratch directory under ${TMPDIR:-/tmp}" \
      "check that \$TMPDIR exists and is writable"

cleanup() { rm -rf -- "$SCRATCH"; }
on_interrupt() {
  trap - INT TERM
  printf '\n\n%sinterrupted%s\n' "$C_CH" "$C_0"
  if [ "$APPLYING" = 0 ]; then
    printf 'Nothing was changed — the report had not been confirmed. Re-run when you are ready.\n'
  else
    printf 'The update was partway through. `git status` in %s shows where the checkout stands;\n' "$REPO_DIR"
    printf 're-run ./scripts/update.sh to finish (it is idempotent).\n'
  fi
  cleanup
  exit 130
}
trap cleanup EXIT
trap on_interrupt INT TERM

ask_yes_no() { # ask_yes_no <question> <default y|n>
  local q="$1" def="$2" reply=""
  if [ "$INTERACTIVE" = 0 ]; then [ "$def" = "y" ]; return $?; fi
  while :; do
    if [ "$def" = "y" ]; then printf '   %s [Y/n]: ' "$q"; else printf '   %s [y/N]: ' "$q"; fi
    IFS= read -r reply < /dev/tty || reply=""
    [ -n "$reply" ] || reply="$def"
    case "$reply" in
      [yY]|[yY][eE][sS]) return 0 ;;
      [nN]|[nN][oO])     return 1 ;;
      *) printf '   %sanswer y or n%s\n' "$C_ER" "$C_0" ;;
    esac
  done
}

# Appends to install.sh's manifest, in install.sh's format and with install.sh's de-duplication.
# An update that created a symlink and did not record it is exactly the orphan the manifest
# design exists to prevent, and uninstall.sh would leave it behind for good.
manifest_add() { # manifest_add <TYPE> <PATH> [DETAIL]
  [ "$DRY_RUN" = 0 ] || return 0
  mkdir -p "$(dirname "$MANIFEST")" 2>/dev/null || true
  if [ -f "$MANIFEST" ] && grep -qF "$(printf '%s\t%s\t' "$1" "$2")" "$MANIFEST" 2>/dev/null; then return 0; fi
  printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$MANIFEST"
}

git_in_repo() { git -C "$REPO_DIR" "$@"; }

# --check writes nothing, so a state that only blocks *applying* an update must not block
# *reporting* one. Refusing there would withhold the exact information the user is asking for
# before deciding whether to clean the tree up. Only a condition that makes the check itself
# impossible — no repo, no upstream, a failed fetch — is fatal under --check.
refuse_or_warn() { # refuse_or_warn <CODE> <cause> <action>
  if [ "$CHECK_ONLY" = 1 ]; then
    warn "$1: $2"
    info "an update would stop here — $3"
    return 0
  fi
  die "$1" "$2" "$3"
}
short() { printf '%s' "${1:0:7}"; }

# Compares ~/.pi/agent against install.sh's link table and the manifest, and says what it found.
#   reconcile_links 1  — after a fast-forward: a config path that is new in this update also gets
#                        the symlink install.sh would have made, and a manifest row for it.
#   reconcile_links 0  — read-only. Used when nothing arrived, where a link that is simply absent
#                        is not "new in this update" but a gap in the install, which is
#                        './scripts/install.sh --repair' to close, not this script's to close
#                        silently. Report-only also keeps --check writing nothing.
# Either way a link somebody re-pointed, and a real file where a link belongs, are reported and
# left exactly as they are — that promise is in docs/getting-started/update.md and is not
# conditional on upstream having moved.
reconcile_links() { # reconcile_links <1 = may create missing links | 0 = report only>
  local _apply="$1" LINKS req src name dst want have m_type m_path m_detail
  # install.sh's link table, read out of install.sh. The alternative is a copy of the table here,
  # which is the two-lists-that-drift failure the manifest design already rejected once.
  LINKS="$SCRATCH/links.tsv"
  awk '/^link_one[ \t]+(required|optional)[ \t]/ { print $2 "\t" $3 "\t" $4 }' \
    "$REPO_DIR/scripts/install.sh" > "$LINKS"
  [ -s "$LINKS" ] || die "PI-UPDATE-E14" "could not read the symlink table out of scripts/install.sh" \
    "the checkout is updated but the reconcile step could not run — finish with ./scripts/install.sh --repair"

  while IFS=$'\t' read -r req src name; do
    [ -n "$name" ] || continue
    dst="$AGENT_DIR/$name"
    want="$STABLE_LINK/$src"
    have="$(readlink "$dst" 2>/dev/null || true)"
    if [ ! -e "$REPO_DIR/$src" ]; then
      # `optional` entries are absent in a normal clone (the repo ships no skills, for one), so
      # their absence is not news. A `required` one going missing is a broken checkout, and saying
      # so here is cheaper than letting PI fail on a config file it cannot resolve.
      if [ "$req" = "required" ]; then
        report_add "config entry '$src' is required but is not in the repo — run ./scripts/install.sh --repair, and re-clone if it persists"
        warn "$name — required, but '$src' is not in the repo (reported)"
      elif [ -n "$have" ]; then
        report_add "$dst points at $have, which is not in the repo — remove the link yourself if you agree it is dead"
        warn "$name — its target is gone from the repo (reported, not removed)"
      fi
      continue
    fi
    if [ "$have" = "$want" ]; then
      ok "$name"
    elif [ -n "$have" ]; then
      # A symlink pointing somewhere else is a decision somebody made. Re-pointing it silently is
      # the same class of mistake as stashing: it discards a choice without recording that it did.
      report_add "$dst points at $have, not at $want — left alone. './scripts/install.sh --repair' re-points it if that is what you want"
      warn "$name — points elsewhere (reported, not changed)"
    elif [ -e "$dst" ]; then
      report_add "$dst is a real file or directory where a symlink to $want is expected — left alone"
      warn "$name — a real path is in the way (reported, not changed)"
    elif [ "$_apply" = 1 ]; then
      run "ln -sfn '$want' '$dst'"
      manifest_add LINK "$dst" "$want"
      changed "$name -> $want (new in this update)"
    else
      report_add "$dst is missing — './scripts/install.sh --repair' creates the link to $want"
      warn "$name — no link (reported; nothing arrived in this run that could have needed one)"
    fi
  done < "$LINKS"

  # Anything the manifest recorded that the repo no longer has. This catches links whose repo path
  # was removed or renamed upstream, including ones outside the link table above.
  if [ -f "$MANIFEST" ]; then
    while IFS=$'\t' read -r m_type m_path m_detail; do
      [ "$m_type" = "LINK" ] || continue
      [ -n "$m_detail" ] || continue
      [ ! -e "$m_detail" ] || continue
      report_add "$m_path -> $m_detail — the target no longer exists"
    done < "$MANIFEST"
  fi
}

# =================================================================================== step 1 ===
section "Checking your checkout" \
  "An update must never be the thing that loses your work, so everything that could be lost is checked before anything moves."

command -v git >/dev/null 2>&1 || \
  die "PI-UPDATE-E03" "git is not on PATH" \
      "install git — this script updates the harness by fast-forwarding its own checkout"

git_in_repo rev-parse --git-dir >/dev/null 2>&1 || \
  die "PI-UPDATE-E04" "$REPO_DIR is not a git checkout" \
      "this script updates a clone of https://github.com/DresvyanskiyDenis/PiON — re-clone it with git, or update by hand"

GIT_DIR_ABS="$(git_in_repo rev-parse --absolute-git-dir)"

# An unfinished rebase/merge/cherry-pick is checked before cleanliness, because during one the
# working tree is *supposed* to be dirty and "you have uncommitted changes" would be a misleading
# diagnosis of a completely different situation.
IN_PROGRESS=""
[ ! -d "$GIT_DIR_ABS/rebase-merge" ] || IN_PROGRESS="a rebase"
[ ! -d "$GIT_DIR_ABS/rebase-apply" ] || IN_PROGRESS="a rebase or an am"
[ ! -f "$GIT_DIR_ABS/MERGE_HEAD" ] || IN_PROGRESS="a merge"
[ ! -f "$GIT_DIR_ABS/CHERRY_PICK_HEAD" ] || IN_PROGRESS="a cherry-pick"
[ ! -f "$GIT_DIR_ABS/REVERT_HEAD" ] || IN_PROGRESS="a revert"
[ ! -f "$GIT_DIR_ABS/BISECT_LOG" ] || IN_PROGRESS="a bisect"
[ -z "$IN_PROGRESS" ] || \
  refuse_or_warn "PI-UPDATE-E05" "$IN_PROGRESS is in progress in $REPO_DIR" \
      "finish it (git rebase --continue / git merge --continue) or abandon it (git rebase --abort / git merge --abort), then re-run"

BRANCH="$(git_in_repo symbolic-ref -q --short HEAD || true)"
[ -n "$BRANCH" ] || \
  die "PI-UPDATE-E06" "HEAD is detached in $REPO_DIR — there is no branch to fast-forward" \
      "check out the branch you track upstream (git checkout main), then re-run"

DIRTY="$SCRATCH/dirty.txt"
git_in_repo status --porcelain --untracked-files=no > "$DIRTY" || true
if [ -s "$DIRTY" ]; then
  printf '\n   %suncommitted changes to tracked files:%s\n' "$C_ER" "$C_0" >&2
  sed 's/^/     /' "$DIRTY" >&2
  printf '\n' >&2
  refuse_or_warn "PI-UPDATE-E07" "the working tree in $REPO_DIR has uncommitted changes (listed above)" \
      "commit them, or 'git stash' them yourself — this script will not stash your work for you, because a stash you did not ask for is a change you will not remember making"
else
  ok "working tree clean, on branch $BRANCH"
fi

UPSTREAM="$(git_in_repo rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
[ -n "$UPSTREAM" ] || \
  die "PI-UPDATE-E08" "branch '$BRANCH' has no upstream, so there is nothing to update from" \
      "set one — git branch --set-upstream-to=origin/$BRANCH $BRANCH — then re-run"
ok "tracking $UPSTREAM"

# The manifest is what makes the reconcile step possible at all. Without it this script can pull
# but cannot tell a config symlink it created from one you made by hand, and guessing there is
# how an update starts deleting things.
if [ ! -f "$MANIFEST" ]; then
  if [ "$CHECK_ONLY" = 1 ]; then
    warn "no install manifest at $MANIFEST — --check will report the incoming commits, but not what they mean for your install"
  else
    die "PI-UPDATE-E09" "no install manifest at $MANIFEST — this machine has no PiON install to update" \
        "run ./scripts/install.sh first; it writes the manifest this script reads back"
  fi
else
  ok "manifest: $MANIFEST ($(wc -l < "$MANIFEST" | tr -d ' ') entries)"
fi

# =================================================================================== step 2 ===
section "Fetching" \
  "Reading what upstream has. This writes nothing outside .git and touches no file you own — including under --check."

BASE="$(git_in_repo rev-parse HEAD)"
git_in_repo fetch --quiet --prune 2>"$SCRATCH/fetch.err" || {
  sed 's/^/     /' "$SCRATCH/fetch.err" >&2
  die "PI-UPDATE-E10" "git fetch failed (output above)" \
      "check your network and your access to the remote, then re-run"
}
TARGET="$(git_in_repo rev-parse '@{u}')"
# The diff base is the merge base, not HEAD. They are the same commit on the fast-forward this
# script exists to perform; they differ under --check on a diverged branch, where a two-dot
# `git diff HEAD @{u}` would list the user's own files as "arriving" — reporting their work back
# to them as somebody else's change.
DIFF_BASE="$(git_in_repo merge-base HEAD '@{u}')"
ok "fetched — $UPSTREAM is at $(short "$TARGET")"

AHEAD="$(git_in_repo rev-list --count '@{u}..HEAD')"
BEHIND="$(git_in_repo rev-list --count 'HEAD..@{u}')"

if [ "$AHEAD" != "0" ]; then
  printf '\n   %syour commits that %s does not have:%s\n' "$C_ER" "$UPSTREAM" "$C_0" >&2
  git_in_repo log --oneline --no-decorate '@{u}..HEAD' | sed 's/^/     /' >&2
  printf '\n' >&2
  refuse_or_warn "PI-UPDATE-E11" "branch '$BRANCH' has diverged: $AHEAD commit(s) of yours, $BEHIND upstream (yours listed above)" \
      "decide yourself how they join — 'git rebase $UPSTREAM' or 'git merge $UPSTREAM' — then re-run. This script only fast-forwards, so that this choice is never made for you"
fi

if [ "$BEHIND" = "0" ]; then
  ok "already up to date — $BRANCH is $UPSTREAM"
  # A converged branch says nothing about ~/.pi/agent, and the symlink report is promised
  # unconditionally in docs/getting-started/update.md. Skipping it here used to let this script
  # print "Nothing to do" over a re-pointed link — true about the branch, false about the install.
  # Read-only: with nothing arriving, no link can be new, so there is nothing to create.
  SECTIONS_TOTAL=3
  section "Checking your install" \
    "Nothing arrived, so nothing is linked here — this only names what does not match install.sh's table."
  reconcile_links 0

  printf '\n%s\n' "-----------------------------------------------------------------------"
  printf '%s  Up to date — 0 step(s) changed%s\n\n' "$C_B" "$C_0"
  printf 'The checkout at %s matches %s.\n' "$REPO_DIR" "$UPSTREAM"
  if [ -n "$REPORTED" ]; then
    printf '\n%sFor you to look at — nothing here was changed:%s%s\n' "$C_CH" "$C_0" "$REPORTED"
    printf '\n%s./scripts/install.sh --repair re-points a link or backs up a file in the way.%s\n' "$C_D" "$C_0"
  else
    printf '\nNothing to do.\n'
  fi
  exit 0
fi

# =================================================================================== step 3 ===
section "What is arriving" \
  "The whole report first, so that one confirmation covers a set of changes you have actually seen."

printf '\n   %s%s commit(s):%s\n' "$C_B" "$BEHIND" "$C_0"
git_in_repo log --oneline --no-decorate "HEAD..@{u}" | sed 's/^/     /'

DIFF="$SCRATCH/diff.tsv"
git_in_repo diff --name-status "$DIFF_BASE" "$TARGET" > "$DIFF"

# Column 2 for every row, plus column 3 for a rename's destination: "which paths exist upstream
# that this checkout will now have".
NEWSIDE="$SCRATCH/newside.txt"
awk -F'\t' '{ if ($1 ~ /^R/) print $3; else if ($1 != "D") print $2 }' "$DIFF" | sort -u > "$NEWSIDE"

# `git diff` gives the letters; this gives them names, because "M" in a list of forty paths is
# not a report, it is a diff.
paths_matching() { # paths_matching <extended regex over the path>
  awk -F'\t' -v re="$1" '
    { p = ($1 ~ /^R/) ? $3 : $2 }
    p ~ re { printf "%s\t%s\n", $1, p }
  ' "$DIFF"
}
describe_status() {
  case "$1" in
    A)   printf 'added' ;;
    D)   printf 'removed' ;;
    M)   printf 'modified' ;;
    R*)  printf 'renamed' ;;
    *)   printf '%s' "$1" ;;
  esac
}

# ------------------------------------------------------------------ config the installer links
CFG="$(paths_matching '^config/')"
if [ -n "$CFG" ]; then
  printf '\n   %sconfig/:%s\n' "$C_B" "$C_0"
  printf '%s\n' "$CFG" | while IFS=$'\t' read -r st p; do
    [ -n "$p" ] || continue
    printf '     %-10s %s\n' "$(describe_status "$st")" "$p"
  done
fi

# ------------------------------------------------------------ the rest, grouped rather than listed
# `scripts/` and the package files are named individually: they change how the install itself
# behaves, and a count would hide which one moved. Everything else is a count, because forty
# doc paths scrolling past is how a reader learns to skip the report.
SCR="$(paths_matching '^scripts/')"
if [ -n "$SCR" ]; then
  printf '\n   %sscripts/:%s\n' "$C_B" "$C_0"
  printf '%s\n' "$SCR" | while IFS=$'\t' read -r st p; do
    [ -n "$p" ] || continue
    printf '     %-10s %s\n' "$(describe_status "$st")" "$p"
  done
fi

PKG="$(paths_matching '^(package\.json|package-lock\.json)$')"
if [ -n "$PKG" ]; then
  printf '\n   %spackages:%s\n' "$C_B" "$C_0"
  printf '%s\n' "$PKG" | while IFS=$'\t' read -r st p; do
    [ -n "$p" ] || continue
    printf '     %-10s %s\n' "$(describe_status "$st")" "$p"
  done
fi

REST="$(awk -F'\t' '
  { p = ($1 ~ /^R/) ? $3 : $2 }
  p ~ /^(config|scripts)\// { next }
  p == "package.json" || p == "package-lock.json" { next }
  {
    if (p ~ /^docs\//)            g = "docs"
    else if (p ~ /^extensions\//) g = "extensions"
    else if (p ~ /^test\//)       g = "tests"
    else                          g = "other"
    n[g]++
  }
  END { for (g in n) printf "%s\t%s\n", g, n[g] }
' "$DIFF" | sort)"
if [ -n "$REST" ]; then
  printf '\n   %selsewhere:%s\n' "$C_B" "$C_0"
  printf '%s\n' "$REST" | while IFS=$'\t' read -r g n; do
    [ -n "$g" ] || continue
    printf '     %-10s %s file(s)\n' "$g" "$n"
  done
fi

# ------------------------------------------------------------------------------- the PI floor
LOCK_MOVED=0
grep -qxF "config/pi-release.lock" "$NEWSIDE" && LOCK_MOVED=1 || true
runtime_version() { # runtime_version <rev>
  git_in_repo show "$1:config/pi-release.lock" 2>/dev/null | \
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).version??"?"))}catch{process.stdout.write("?")}})' 2>/dev/null || printf '?'
}
node_floor() { # node_floor <rev>
  git_in_repo show "$1:package.json" 2>/dev/null | \
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).engines?.node??"?"))}catch{process.stdout.write("?")}})' 2>/dev/null || printf '?'
}
if command -v node >/dev/null 2>&1; then
  if [ "$LOCK_MOVED" = 1 ]; then
    _old="$(runtime_version "$DIFF_BASE")"; _new="$(runtime_version "$TARGET")"
    if [ "$_old" != "$_new" ]; then
      printf '\n   %sPI runtime pin: %s -> %s%s\n' "$C_CH" "$_old" "$_new" "$C_0"
      todo_add "     the pinned PI version moved to $_new — run ./scripts/install.sh --repair to install it (this script updates the repo, not the binary)"
    else
      info "config/pi-release.lock changed, but the pinned PI version is still $_new"
    fi
  fi
  _oldn="$(node_floor "$DIFF_BASE")"; _newn="$(node_floor "$TARGET")"
  if [ "$_oldn" != "$_newn" ]; then
    printf '\n   %sNode floor: %s -> %s  (you are running %s)%s\n' "$C_CH" "$_oldn" "$_newn" "$(node --version)" "$C_0"
    report_add "the required Node version moved to $_newn — check 'node --version' before the next PI run"
  fi
else
  warn "node is not on PATH — cannot report whether the PI or Node version floors moved"
fi

# -------------------------------------------------------------------------------- packages
# package.json alone is deliberately NOT enough: it changes for a version bump or a script
# rename that installs nothing. `npm ci` is driven by the lockfile, so the lockfile is the trigger.
LOCK_CHANGED=0
grep -qxF "package-lock.json" "$NEWSIDE" && LOCK_CHANGED=1 || true

# ------------------------------------------------------------ things this script will not do
# A tracked file arriving on top of an untracked file of the same name is git's own refusal, and
# it happens after the fetch has already succeeded — better to name the files here, while the
# checkout is still exactly where the user left it.
COLLIDE=""
CLOBBER=""
while IFS= read -r p; do
  [ -n "$p" ] || continue
  [ -e "$REPO_DIR/$p" ] || continue
  git_in_repo ls-files --error-unmatch -- "$p" >/dev/null 2>&1 && continue
  if git_in_repo check-ignore -q -- "$p" 2>/dev/null; then
    # git's own protection does NOT extend here: it refuses to overwrite an untracked file, but an
    # IGNORED one it replaces without a word. So this is the only collision the user cannot see
    # coming, on the one class of file that is theirs by construction — a generated config, which
    # install.sh writes once and never resets, and which carries their gateway URL and model list.
    # Reporting it and fast-forwarding anyway (what this did until the check below existed) is the
    # one way this script could destroy work: the report even said "would be overwritten", in the
    # future tense, under a heading promising nothing had changed.
    # Identical content is nothing to lose, and refusing there would be a rule with no victim.
    if git_in_repo show "$TARGET:$p" 2>/dev/null | cmp -s - "$REPO_DIR/$p"; then continue; fi
    CLOBBER="$CLOBBER
     $p"
  else
    COLLIDE="$COLLIDE
     $p"
  fi
done < "$NEWSIDE"
if [ -n "$COLLIDE" ]; then
  printf '\n   %suntracked files in the way:%s%s\n' "$C_ER" "$C_0" "$COLLIDE" >&2
  printf '\n' >&2
  refuse_or_warn "PI-UPDATE-E12" "upstream adds files that already exist here as untracked files (listed above)" \
      "move or delete your copies — git refuses to overwrite an untracked file, and so does this script"
fi
if [ -n "$CLOBBER" ]; then
  printf '\n   %sgit-ignored files here that upstream now tracks:%s%s\n' "$C_ER" "$C_0" "$CLOBBER" >&2
  printf '\n' >&2
  refuse_or_warn "PI-UPDATE-E17" "upstream now tracks files that exist here as git-ignored files with different contents (listed above) — a fast-forward would overwrite them silently, because being ignored is exactly what removes git's own protection" \
      "copy yours aside first, then re-run — these are generated files, and './scripts/install.sh --repair' regenerates one from its template plus your answers once you have what you wanted out of it"
fi

# A generated config is yours the moment install.sh writes it: install.sh patches it and never
# resets it. So an upstream change to its template is a change you did NOT get, and the only
# useful thing to do about it is say so by name. Resolving it means merging a template into a
# file the user may have hand-edited, which is a judgement call, not an automation.
while IFS=$'\t' read -r st p; do
  [ -n "$p" ] || continue
  case "$p" in config/*.default.json) : ;; *) continue ;; esac
  _name="${p#config/}"; _name="${_name%.default.json}"
  if [ -f "$REPO_DIR/config/$_name.json" ]; then
    report_add "config/$_name.default.json was $(describe_status "$st") upstream — your generated config/$_name.json is yours and stays untouched. Compare them, or re-run ./scripts/install.sh --reconfigure"
  elif [ "$st" = "A" ]; then
    todo_add "     config/$_name.json does not exist yet — run ./scripts/install.sh --repair to generate it from the new template"
  fi
done < "$DIFF"

if paths_matching '^config/providers/' | grep -q .; then
  report_add "a provider fragment changed — config/models.json is generated from these and was NOT regenerated. Run ./scripts/install.sh --reconfigure --section providers to pick the change up"
fi

# --------------------------------------------------- interview answers the new revision wants
# Derived from install.sh's own source at both revisions rather than from a list kept here: a
# second list of interview keys would drift from the interview on the first commit that touched
# it, and the drift would be silent. A key built from a variable (ask "env.$e_name") is skipped
# rather than guessed at — a wrong section name in this report is worse than a missing one.
ask_keys() { # ask_keys <rev> -> key<TAB>section
  git_in_repo show "$1:scripts/install.sh" 2>/dev/null | awk '
    match($0, /ask_section[ \t]+[a-z][a-z]*/) {
      s = substr($0, RSTART, RLENGTH); sub(/ask_section[ \t]+/, "", s); sect = s
    }
    /^[ \t]*ask[ \t]+[a-zA-Z_][a-zA-Z0-9._]*[ \t]/ {
      k = $2
      if (k ~ /^[a-zA-Z_][a-zA-Z0-9._]*$/) print k "\t" (sect == "" ? "-" : sect)
    }
  ' | sort -u
}
if git_in_repo diff --quiet "$DIFF_BASE" "$TARGET" -- scripts/install.sh; then :; else
  ask_keys "$DIFF_BASE" | cut -f1 > "$SCRATCH/keys.old"
  ask_keys "$TARGET" > "$SCRATCH/keys.new"
  while IFS=$'\t' read -r k sect; do
    [ -n "$k" ] || continue
    grep -qxF "$k" "$SCRATCH/keys.old" && continue
    [ ! -f "$ANSWERS_FILE" ] || ! grep -q "^$k=" "$ANSWERS_FILE" || continue
    if [ "$sect" = "-" ]; then
      todo_add "     the interview gained a new question ('$k') — run ./scripts/install.sh --reconfigure to answer it"
    else
      todo_add "     the interview gained a new question ('$k') — run ./scripts/install.sh --reconfigure --section $sect to answer it"
    fi
  done < "$SCRATCH/keys.new"
fi

# This script is one of the files that can arrive in the update, and the run continues under the
# version that started it. Saying so is cheaper than an exec dance whose failure mode is a
# half-applied update under two different scripts.
SELF_CHANGED=0
grep -qxF "scripts/update.sh" "$NEWSIDE" && SELF_CHANGED=1 || true

# =================================================================================== review ===
step "Review — nothing has been written yet"

printf '\n%s  This is everything the update will do:%s\n' "$C_B" "$C_0"
printf '\n   checkout       %s\n' "$REPO_DIR"
printf '   branch         %s -> %s (fast-forward, %s commit(s))\n' "$BRANCH" "$UPSTREAM" "$BEHIND"
printf '   symlinks       reconciled against %s\n' "$MANIFEST"
printf '   packages       %s\n' \
  "$( if [ "$SKIP_PACKAGES" = 1 ]; then printf 'untouched (--skip-packages)'
      elif [ "$LOCK_CHANGED" = 1 ]; then printf 'npm ci --ignore-scripts (the lockfile changed)'
      else printf 'untouched — the lockfile did not change'; fi )"
printf '   verification   %s\n' \
  "$( [ "$RUN_VERIFY" = 1 ] && printf 'scripts/postinstall-verify.sh' || printf 'skipped (--no-verify)' )"
if [ -n "$REPORTED" ]; then
  printf '\n   %sfor you to look at — this script will not touch any of these:%s%s\n' "$C_CH" "$C_0" "$REPORTED"
fi
# Repeated verbatim in the summary at the end. Both places, on purpose: --check never reaches
# the summary, and by the time an interactive run does, the confirmation has already happened —
# a manual step you only learn about afterwards is not part of the decision you were asked to make.
if [ -n "$MANUAL_TODO" ]; then
  printf '\n   %sand things only you can do, listed again at the end:%s\n' "$C_CH" "$C_0"
  printf '%s\n' "$MANUAL_TODO" | while IFS= read -r t; do
    [ -n "$t" ] || continue
    printf '   %s\n' "$(printf '%s' "$t" | sed 's/^ *//;s/^/     /')"
  done
fi
[ "$SELF_CHANGED" = 0 ] || printf '\n   %sscripts/update.sh itself changes in this update; the rest of this run uses the version already loaded.%s\n' "$C_D" "$C_0"

if [ "$CHECK_ONLY" = 1 ]; then
  printf '\n%s\n' "-----------------------------------------------------------------------"
  printf '%s  An update is available — %s commit(s) behind %s%s\n\n' "$C_B" "$BEHIND" "$UPSTREAM" "$C_0"
  printf 'Nothing was changed. Run ./scripts/update.sh to apply it.\n'
  exit 3
fi

if [ "$INTERACTIVE" = 1 ]; then
  printf '\n'
  ask_yes_no "go ahead?" y || { printf '\nnothing was changed. Re-run when you are ready.\n'; exit 0; }
fi

APPLYING=1

# =================================================================================== step 4 ===
section "Updating the checkout" \
  "Fast-forward only. If git refuses, the checkout stays exactly where it is."

if ! run "git -C '$REPO_DIR' merge --ff-only '@{u}' >'$SCRATCH/ff.out' 2>&1"; then
  sed 's/^/     /' "$SCRATCH/ff.out" >&2 2>/dev/null || true
  die "PI-UPDATE-E13" "git merge --ff-only refused (output above)" \
      "read the message; the checkout is unchanged. Resolve it by hand in $REPO_DIR and re-run"
fi
changed "$BRANCH: $(short "$BASE") -> $(short "$TARGET") ($BEHIND commit(s))"

# =================================================================================== step 5 ===
section "Reconciling your install" \
  "New config files need the symlinks install.sh would have made; ones that went away are named, never deleted."

reconcile_links 1

# =================================================================================== step 6 ===
section "Packages and verification" \
  "npm only when the lockfile actually moved, then the same post-install check install.sh runs as its last step."

if [ "$SKIP_PACKAGES" = 1 ]; then
  info "npm skipped (--skip-packages)"
elif [ "$LOCK_CHANGED" = 0 ]; then
  ok "package-lock.json unchanged — no npm run needed"
elif ! command -v npm >/dev/null 2>&1; then
  die "PI-UPDATE-E15" "the lockfile changed in this update but npm is not on PATH" \
      "install Node/npm and re-run, or re-run with --skip-packages and install the packaged extensions yourself"
else
  if ! run "cd '$REPO_DIR' && npm ci --ignore-scripts >'$SCRATCH/npm.out' 2>&1"; then
    tail -n 20 "$SCRATCH/npm.out" 2>/dev/null | sed 's/^/     /' >&2 || true
    die "PI-UPDATE-E16" "npm ci failed (last lines above; full output in $SCRATCH/npm.out, which this run is about to delete)" \
        "run 'npm ci --ignore-scripts' in $REPO_DIR yourself and read the error"
  fi
  changed "npm ci --ignore-scripts (the lockfile changed)"
fi

# The update landed. `<agent-dir>/update-pending` is the note scripts/auto-update-check.sh leaves
# for extensions/auto-update to read at session start, and it is now describing an update that has
# been applied. Clearing it here rather than leaving it to the next cron tick is the difference
# between "applied, and the next session is quiet" and "applied, and every session for the next
# half hour still announces it".
FLAG_FILE="$AGENT_DIR/update-pending"
if [ "$DRY_RUN" = 1 ]; then
  [ ! -f "$FLAG_FILE" ] || info "a real run would clear $FLAG_FILE"
elif [ -f "$FLAG_FILE" ]; then
  if rm -f "$FLAG_FILE"; then changed "cleared $FLAG_FILE — the update it announced is this one"
  else warn "could not remove $FLAG_FILE — the next session will announce an update that is already applied"; fi
fi

if [ "$RUN_VERIFY" = 0 ]; then
  info "verification skipped (--no-verify)"
elif [ "$DRY_RUN" = 1 ]; then
  info "a real run would now execute scripts/postinstall-verify.sh"
elif [ -x "$REPO_DIR/scripts/postinstall-verify.sh" ]; then
  # postinstall-verify.sh is the script that owns the doctor-backed checks (it calls the /doctor
  # command itself once extensions/doctor is present). Calling doctor a second time from here
  # would be a second, divergent opinion about what "verified" means.
  if PI_CODING_AGENT_DIR="$AGENT_DIR" PI_INSTALL_PREFIX="$PREFIX" "$REPO_DIR/scripts/postinstall-verify.sh"; then
    ok "postinstall-verify.sh: no failures"
  else
    FINAL_EXIT=4
    warn "postinstall-verify.sh reported failures — the update landed; read its table above"
  fi
else
  warn "scripts/postinstall-verify.sh not found — skipping verification"
fi

# ==================================================================================== summary ===
printf '\n%s\n' "-----------------------------------------------------------------------"
printf '%s  Done — %s step(s) changed%s\n' "$C_B" "$CHANGED" "$C_0"
printf '\nWhat changed for you:\n'
printf '   branch       %s, now at %s\n' "$BRANCH" "$(short "$TARGET")"
printf '   commits      %s applied\n' "$BEHIND"
printf '   live config  %s -> %s\n' "$AGENT_DIR" "$STABLE_LINK"
printf '   manifest     %s\n' "$MANIFEST"

# A credential referenced by the generated config but absent from both the environment and the
# secrets file. Read from the live config rather than from the provider fragments: the fragments
# carry placeholder names ($YOUR_KEY_VAR) that are documentation, not requirements.
if [ -f "$REPO_DIR/config/models.json" ]; then
  MISSING_ENV=""
  for v in $(grep -oE '\$\{?[A-Z][A-Z0-9_]*\}?' "$REPO_DIR/config/models.json" 2>/dev/null \
             | tr -d '${}' | sort -u); do
    eval "_val=\${$v:-}"
    [ -z "$_val" ] || continue
    if [ -f "$SECRETS_FILE" ] && grep -q "^\(export \)\{0,1\}$v=" "$SECRETS_FILE" 2>/dev/null; then continue; fi
    MISSING_ENV="$MISSING_ENV $v"
  done
  if [ -n "$MISSING_ENV" ]; then
    printf '\n%sCredential variables your config references that are not set here:%s\n' "$C_CH" "$C_0"
    for v in $MISSING_ENV; do printf '   %s\n' "$v"; done
    printf '%s(set them in %s, or re-run ./scripts/install.sh --section providers)%s\n' "$C_D" "$SECRETS_FILE" "$C_0"
  fi
fi

if [ -n "$REPORTED" ]; then
  printf '\n%sFor you to look at — nothing here was changed:%s%s\n' "$C_CH" "$C_0" "$REPORTED"
fi

if [ -n "$MANUAL_TODO" ]; then
  printf '\n%sStill yours to do by hand:%s\n' "$C_CH" "$C_0"
  _n=0
  printf '%s\n' "$MANUAL_TODO" | while IFS= read -r t; do
    [ -n "$t" ] || continue
    _n=$((_n + 1))
    printf '  %d. %s\n' "$_n" "$(printf '%s' "$t" | sed 's/^ *//')"
  done
elif [ "$FINAL_EXIT" = 4 ]; then
  # The update itself left no manual step — MANUAL_TODO is genuinely empty — but printing "nothing
  # is left for you to do" directly beneath a verification table with failures in it contradicts
  # the exit code this run is about to return (4: "read its table"). The reader trusts the last
  # line, so the last line has to agree with the code.
  printf '\n%sThe update left nothing for you to do by hand — but verification above reported\n' "$C_CH"
  printf 'failures. Work through that table before starting pi; this run exits 4 for that reason.%s\n' "$C_0"
else
  printf '\n%sNothing is left for you to do by hand.%s\n' "$C_OK" "$C_0"
fi

if [ "$SELF_CHANGED" = 1 ]; then
  printf '\n%sscripts/update.sh changed in this update. This run used the previous version;%s\n' "$C_D" "$C_0"
  printf '%sthe next one will use the new one. Nothing needs re-running.%s\n' "$C_D" "$C_0"
fi

printf '\nNext:\n'
printf '   pi                  # start the agent\n'
printf '\nTo change an answer:       ./scripts/install.sh --reconfigure   (or --section providers)\n'
printf 'To re-link and re-verify:  ./scripts/install.sh --repair\n'
printf 'Docs:                      docs/getting-started/update.md\n'
printf '                           https://dresvyanskiydenis.github.io/PiON/getting-started/update/\n'
[ "$DRY_RUN" = 0 ] || printf '\n%sThis was a dry run — nothing above was actually written.%s\n' "$C_CH" "$C_0"

exit "$FINAL_EXIT"
