#!/usr/bin/env bash
# uninstall.sh — take the harness back out, with the same care install.sh put it in.
#
# PiON — a hardened, portable harness for the PI coding agent.
#   https://dresvyanskiydenis.github.io/PiON/
#
# HOW IT KNOWS WHAT TO REMOVE
# install.sh writes every path it creates into ~/.pi/agent/install-manifest.tsv as it creates it:
#
#     TYPE <TAB> PATH <TAB> DETAIL
#
# and this script reads that file back. That is the whole design. The alternative — two lists,
# one in each script, kept in step by hand — drifts the moment anybody adds a config file, and
# the failure is silent: an orphan symlink nobody notices for a year. With the manifest there is
# exactly one list, written by the code that does the creating.
#
#   DIR        a directory install.sh created        removed only if it is empty afterwards
#   TREE       a directory install.sh unpacked       removed with everything in it — the only
#              whole: the pi runtime, under          recursive delete driven by the manifest,
#              .local/share/pi-config/runtime/       and refused for a path outside $PREFIX
#   LINK       a symlink; DETAIL is its target       removed only if it still points there
#   FILE       a real file install.sh wrote          removed
#   GENERATED  config/*.json built from your answers removed (never a *.default.json template)
#   PATCHED    a TRACKED repo file it edited         NEVER removed — reported, restore with git
#   RCBLOCK    a fenced block in a shell rc file     the block is cut out, the rest is left alone
#   BACKUP     something it moved aside for you      kept unless you say otherwise
#   SECRETS    your credentials file                 kept unless you say otherwise
#   KEYCHAIN   a macOS Keychain item it created      kept unless you say otherwise
#   NPMGLOBAL  a package installed with              asked about on its own — it lives outside
#              'npm install -g' (the pi runtime      $PREFIX, in npm's global tree, so it is the
#              itself in npm mode, or a language     one class of removal that is shared machine
#              server)                                state rather than something scoped to you
#
# EXIT CODES
#   0    clean — everything listed was either removed or kept by an explicit choice; nothing
#        had to be skipped. Also the "nothing to remove" and "you said no at the end" cases.
#   1    fatal — could not run to completion; see the FAILED block printed above the exit.
#   2    usage — a bad flag, or a flag that needed an argument and did not get one.
#   3    partial — the run finished, but at least one item was SKIPPED (a re-pointed symlink, a
#        failed 'npm uninstall -g', a locked Keychain item, ...). Every skip is printed above
#        with the reason and, where there is one, the exact command to finish the job by hand.
#   130  interrupted (Ctrl-C / SIGTERM) partway through — re-run to finish; some items may
#        already be gone.
# A script driving this one should treat 0 and 3 as "ran fine, check for a 3 if it must know
# whether anything needs manual follow-up", and anything else as "did not finish".
#
# If the manifest is missing (installed by an older version, or deleted) the script says so and
# falls back to a conservative scan: symlinks under ~/.pi/agent and ~/bin that point into this
# checkout, and the fenced blocks in your rc files. It never guesses about anything else.
#
# WHAT IT WILL NOT DO, EVER
#   * delete a symlink that no longer points where install.sh put it (someone re-pointed it)
#   * delete a real file where the manifest says there should be a symlink
#   * delete config/*.default.json — those are the repo's shipped templates, not your config
#   * delete credentials, sessions, transcripts or PI's own auth without a separate, explicit yes
#   * touch anything under a path it did not create
#
# Usage:
#   ./scripts/uninstall.sh              # interactive: preview, questions, one confirmation
#   ./scripts/uninstall.sh --dry-run    # print every action, change nothing
#   ./scripts/uninstall.sh --yes        # no questions; keeps all personal data
#   ./scripts/uninstall.sh --purge      # also removes credentials, sessions and PI's own state
#   ./scripts/uninstall.sh --prefix DIR # a sandbox install made with install.sh --prefix DIR
#
# Pre-answering one question, for unattended runs. The interactive question is still asked when
# neither flag is given — these exist so that `--yes` has a defined meaning for the one directory
# whose contents are ambiguous (derived state that is expensive to lose, but not personal):
#   ./scripts/uninstall.sh --purge-state   # remove $XDG_STATE_HOME/pi-config without asking
#   ./scripts/uninstall.sh --keep-state    # keep it without asking, even under --purge

set -euo pipefail

# ---------------------------------------------------------------------------- flags + paths ---
PREFIX="${PI_INSTALL_PREFIX:-$HOME}"
DRY_RUN=0
YES=0
PURGE=0
MANIFEST_OVERRIDE=""
# "" = ask (or follow --purge / --yes). 1 = remove, 0 = keep. A tri-state rather than a boolean,
# because "the flag was not given" and "the flag said no" have to stay different answers.
FORCE_STATE=""

# The range ends on the last comment line of the header block above, not a line or two past it:
# `sed` would happily print `set -euo pipefail` into the help text.
usage() { sed -n '2,69p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)  DRY_RUN=1; shift ;;
    --yes|-y)   YES=1; shift ;;
    --purge)    PURGE=1; shift ;;
    --purge-state) FORCE_STATE=1; shift ;;
    --keep-state)  FORCE_STATE=0; shift ;;
    --prefix)   PREFIX="${2:?--prefix needs a directory}"; shift 2 ;;
    --manifest) MANIFEST_OVERRIDE="${2:?--manifest needs a file}"; shift 2 ;;
    -h|--help)  usage ;;
    # Coded like install.sh's own failures, and raised before anything is read or removed: a typo
    # in a destructive command must stop the run, never degrade into a partial uninstall.
    *) printf 'PI-UNINSTALL-E01: unknown argument %s\n  action: run ./scripts/uninstall.sh --help\n' "$1" >&2
       exit 2 ;;
  esac
done

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
STABLE_LINK="$PREFIX/pi-config"
BIN_DIR="$PREFIX/bin"
PI_HOME="$PREFIX/.pi"
# Same rule as install.sh: $PI_CODING_AGENT_DIR is honoured for a normal install into $HOME, but
# a --prefix run is deliberately isolated and must not be redirected back onto the real install.
if [ "$PREFIX" = "$HOME" ]; then AGENT_DIR="${PI_CODING_AGENT_DIR:-$PI_HOME/agent}"
else AGENT_DIR="$PI_HOME/agent"; fi
SECRETS_FILE="$PI_HOME/secrets.env"
CACHE_DIR="$PREFIX/.cache/pi-install"
STATE_DIR="${XDG_STATE_HOME:-$PREFIX/.local/state}/pi-config"
MANIFEST="${MANIFEST_OVERRIDE:-$AGENT_DIR/install-manifest.tsv}"

MARKER="# >>> pi-config >>>"
MARKER_H="# >>> pi-config (headless) >>>"

# --------------------------------------------------------------------------------- output ---
# Colour only for a real terminal, and NO_COLOR is honoured — the same rule as install.sh.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_OK=$'\033[32m'; C_CH=$'\033[33m'; C_ER=$'\033[31m'; C_D=$'\033[2m'; C_B=$'\033[1m'; C_0=$'\033[0m'
else C_OK=""; C_CH=""; C_ER=""; C_D=""; C_B=""; C_0=""; fi

REMOVED=0; KEPT=0; SKIPPED=0

step()    { printf '\n%s== %s%s\n' "$C_B" "$*" "$C_0"; }
ok()      { printf '   %sOK%s  %s\n' "$C_OK" "$C_0" "$*"; }
# Under --dry-run the verb changes but the accounting does not: the same line count, the same
# final total, so a dry run and the real run can be diffed against each other.
gone()    {
  if [ "$DRY_RUN" = 1 ]; then printf '   %swould remove%s %s\n' "$C_CH" "$C_0" "$*"
  else printf '   %sremoved%s %s\n' "$C_CH" "$C_0" "$*"; fi
  REMOVED=$((REMOVED + 1))
}
kept()    { printf '   %skept%s %s\n' "$C_D" "$C_0" "$*"; KEPT=$((KEPT + 1)); }
warn()    { printf '   %s!%s   %s\n' "$C_CH" "$C_0" "$*" >&2; SKIPPED=$((SKIPPED + 1)); }
info()    { printf '   %s- %s%s\n' "$C_D" "$*" "$C_0"; }
die() { printf '\n%sFAILED %s%s\n  cause:  %s\n  action: %s\n\n' "$C_ER" "$1" "$C_0" "$2" "$3" >&2; exit 1; }

# Prompts are read from the terminal, not from stdin: this script must stay usable when its stdout
# is being piped to a log.
INTERACTIVE=1
if [ "$YES" = 1 ] || [ ! -r /dev/tty ]; then INTERACTIVE=0; fi
# shellcheck disable=SC2229  # deliberate: `read -r "$__v"` reads into the variable NAMED by __v,
# which is the whole point of this helper. Dropping the `$` would read into __v itself.
_read_tty() { local __v="$1"; IFS= read -r "$__v" < /dev/tty || eval "$__v=''"; }

# ask_yes_no <question> <default y|n> — non-interactively the default is taken silently.
ask_yes_no() {
  local q="$1" def="$2" reply=""
  if [ "$INTERACTIVE" = 0 ]; then [ "$def" = "y" ]; return $?; fi
  while :; do
    if [ "$def" = "y" ]; then printf '   %s [Y/n]: ' "$q"; else printf '   %s [y/N]: ' "$q"; fi
    _read_tty reply; [ -n "$reply" ] || reply="$def"
    case "$reply" in
      [yY]|[yY][eE][sS]) return 0 ;;
      [nN]|[nN][oO])     return 1 ;;
      *) printf '   %sanswer y or n%s\n' "$C_ER" "$C_0" ;;
    esac
  done
}

# ------------------------------------------------------------------------ scratch + traps ---
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pi-uninstall.XXXXXX")" ||
  die "PI-UNINSTALL-E01" "cannot create a scratch directory under ${TMPDIR:-/tmp}" \
      "check that \$TMPDIR exists and is writable"
cleanup() { rm -rf -- "$SCRATCH"; }
on_interrupt() {
  trap - INT TERM
  printf '\n\n%sinterrupted%s — %s item(s) had already been removed; re-run to finish\n' "$C_CH" "$C_0" "$REMOVED" >&2
  cleanup; exit 130
}
trap cleanup EXIT
trap on_interrupt INT TERM

# run <quoted command string> — echoed under --dry-run, performed otherwise. Same convention as
# install.sh so the two scripts read the same way.
# shellcheck disable=SC2294
# Silent under --dry-run on purpose: the caller's own gone()/warn() line already names the path,
# and printing the shell command as well doubled every line of the preview.
run() { if [ "$DRY_RUN" = 1 ]; then return 0; else eval "$@"; fi; }

printf '\n%s%s  PiON uninstaller  %s\n' "$C_B" "$C_OK" "$C_0"
printf '%sIt removes what install.sh created, and nothing else. You are asked about anything\n' "$C_D"
printf 'that holds your own data before it goes.%s\n' "$C_0"
printf '\nrepo:   %s\n' "$REPO_DIR"
[ "$PREFIX" = "$HOME" ] || printf 'prefix: %s (not $HOME)\n' "$PREFIX"
[ "$DRY_RUN" = 0 ] || printf '%sdry run: every action is printed, nothing is removed%s\n' "$C_CH" "$C_0"

# ================================================================= 1. read the manifest ======
step "1 of 4 — Working out what was installed"
info "The installer recorded every path it created; this reads that record back."

LINKS="$SCRATCH/links";       : > "$LINKS"      # path<TAB>target
FILES="$SCRATCH/files";       : > "$FILES"      # path<TAB>why
GENERATED="$SCRATCH/gen";     : > "$GENERATED"
PATCHED="$SCRATCH/patched";   : > "$PATCHED"
RCBLOCKS="$SCRATCH/rc";       : > "$RCBLOCKS"   # path<TAB>marker
DIRS="$SCRATCH/dirs";         : > "$DIRS"
BACKUPS="$SCRATCH/backups";   : > "$BACKUPS"
KEYCHAIN="$SCRATCH/keychain"; : > "$KEYCHAIN"
SECRETS_ROWS="$SCRATCH/secrets"; : > "$SECRETS_ROWS"
NPMGLOBAL="$SCRATCH/npmglobal"; : > "$NPMGLOBAL"  # package name<TAB>why
# TREE is the one row type that authorises a recursive delete, so it is deliberately narrow: it
# means "install.sh created this whole directory and everything in it", which today is only the
# unpacked pi runtime ($PREFIX/.local/share/pi-config/runtime/<version>). DIR, by contrast, means
# "install.sh created this directory, but its contents may be yours" and is only ever rmdir'd. Do
# not widen TREE to a directory a user might have put files in — and never to one another
# installer writes, which is why the runtime does not live in PI's own $PREFIX/.local/pi/.
TREES="$SCRATCH/trees";       : > "$TREES"        # path<TAB>what it is

MANIFEST_FOUND=0
if [ -f "$MANIFEST" ]; then
  MANIFEST_FOUND=1
  # The manifest is TAB-separated and written only by install.sh; a row with an empty PATH is
  # skipped rather than treated as "the current directory", which is how an rm -rf accident starts.
  while IFS=$'\t' read -r m_type m_path m_detail; do
    [ -n "${m_path:-}" ] || continue
    case "$m_type" in
      LINK)      printf '%s\t%s\n' "$m_path" "${m_detail:-}" >> "$LINKS" ;;
      FILE)      printf '%s\t%s\n' "$m_path" "${m_detail:-}" >> "$FILES" ;;
      GENERATED) printf '%s\t%s\n' "$m_path" "${m_detail:-}" >> "$GENERATED" ;;
      PATCHED)   printf '%s\t%s\n' "$m_path" "${m_detail:-}" >> "$PATCHED" ;;
      RCBLOCK)   printf '%s\t%s\n' "$m_path" "${m_detail:-}" >> "$RCBLOCKS" ;;
      DIR)       printf '%s\n'     "$m_path" >> "$DIRS" ;;
      TREE)      printf '%s\t%s\n' "$m_path" "${m_detail:-}" >> "$TREES" ;;
      BACKUP)    printf '%s\t%s\n' "$m_path" "${m_detail:-}" >> "$BACKUPS" ;;
      KEYCHAIN)  printf '%s\t%s\n' "$m_path" "${m_detail:-}" >> "$KEYCHAIN" ;;
      SECRETS)   printf '%s\t%s\n' "$m_path" "${m_detail:-}" >> "$SECRETS_ROWS" ;;
      NPMGLOBAL) printf '%s\t%s\n' "$m_path" "${m_detail:-}" >> "$NPMGLOBAL" ;;
      *) warn "manifest row with unknown type '$m_type' for $m_path — left alone" ;;
    esac
  done < "$MANIFEST"
  ok "manifest: $MANIFEST ($(wc -l < "$MANIFEST" | tr -d ' ') entries)"
else
  warn "no manifest at $MANIFEST"
  info "That file is written by install.sh. Without it this can only remove what it can prove is"
  info "ours: symlinks that point into this checkout, and the fenced blocks in your rc files."
  info "Anything else has to go by hand — the alternative is guessing, and guessing deletes data."
  info "This includes anything install.sh ran as 'npm install -g' (the pi runtime itself, if it"
  info "was installed in npm mode, or the TypeScript language servers) — a global npm package"
  info "leaves no evidence at this path, so it cannot be told apart from one you installed"
  info "yourself. Check by hand: npm ls -g --depth=0, cross-checked against"
  info "$REPO_DIR/config/pi-release.lock's \"npm.package\"."
  # Conservative reconstruction. Only symlinks are considered, and only those resolving into the
  # repo, because a symlink's target is evidence; a plain file's presence is not.
  for d in "$AGENT_DIR" "$BIN_DIR"; do
    [ -d "$d" ] || continue
    for entry in "$d"/* "$d"/.[!.]*; do
      [ -L "$entry" ] || continue
      tgt="$(readlink "$entry")"
      case "$tgt" in
        "$STABLE_LINK"/*|"$REPO_DIR"/*) printf '%s\t%s\n' "$entry" "$tgt" >> "$LINKS" ;;
      esac
    done
  done
  if [ -L "$STABLE_LINK" ]; then printf '%s\t%s\n' "$STABLE_LINK" "$(readlink "$STABLE_LINK")" >> "$LINKS"; fi
  for rc in "$PREFIX/.zshrc" "$PREFIX/.bashrc" "$PREFIX/.profile" "$PREFIX/.zshenv" "$PREFIX/.bash_profile"; do
    [ -f "$rc" ] || continue
    if grep -qF "$MARKER"   "$rc" 2>/dev/null; then printf '%s\t%s\n' "$rc" "$MARKER"   >> "$RCBLOCKS"; fi
    if grep -qF "$MARKER_H" "$rc" 2>/dev/null; then printf '%s\t%s\n' "$rc" "$MARKER_H" >> "$RCBLOCKS"; fi
  done
  # The generated half of every template/generated pair install.sh writes. Named explicitly rather
  # than globbed, because a glob over config/*.json would also sweep up the files this repo really
  # does track — compaction.json, dispatch.json, tools.declared.json — none of which the installer
  # created and none of which it may remove.
  for g in models routing mcp settings guard trusted-roots path-defaults web web-search quota; do
    if [ -f "$REPO_DIR/config/$g.json" ]; then
      printf '%s\t%s\n' "$REPO_DIR/config/$g.json" "generated config (found by scan)" >> "$GENERATED"
    fi
  done
  ok "reconstructed $(wc -l < "$LINKS" | tr -d ' ') symlink(s) and $(wc -l < "$RCBLOCKS" | tr -d ' ') rc block(s) by scanning"
fi

if [ ! -s "$LINKS" ] && [ ! -s "$FILES" ] && [ ! -s "$GENERATED" ] && [ ! -s "$RCBLOCKS" ] && [ ! -s "$NPMGLOBAL" ]; then
  printf '\nNothing to remove: no manifest, no symlinks into this checkout, no rc blocks.\n'
  printf 'If you expected an install here, check --prefix (currently %s).\n' "$PREFIX"
  exit 0
fi

# ===================================================================== 2. preview ============
step "2 of 4 — What will be removed"
info "Nothing has been touched yet. This is the whole list, grouped."

count_of() { [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || printf '0'; }

if [ -s "$LINKS" ]; then
  printf '\n   %ssymlinks%s (%s) — the live config; removing them does not touch the repo\n' \
    "$C_B" "$C_0" "$(count_of "$LINKS")"
  while IFS=$'\t' read -r l_path l_target; do
    if [ -L "$l_path" ]; then printf '     %s\n' "$l_path"
    else printf '     %s%s  (already gone)%s\n' "$C_D" "$l_path" "$C_0"; fi
  done < "$LINKS"
fi

if [ -s "$GENERATED" ]; then
  printf '\n   %sgenerated config%s (%s) — built from your answers, git-ignored, yours alone\n' \
    "$C_B" "$C_0" "$(count_of "$GENERATED")"
  while IFS=$'\t' read -r g_path g_why; do printf '     %s\n' "$g_path"; done < "$GENERATED"
  info "the shipped config/*.default.json templates are NOT touched"
fi

if [ -s "$FILES" ]; then
  printf '\n   %sinstaller files%s (%s)\n' "$C_B" "$C_0" "$(count_of "$FILES")"
  while IFS=$'\t' read -r f_path f_why; do printf '     %-58s %s%s%s\n' "$f_path" "$C_D" "$f_why" "$C_0"; done < "$FILES"
fi

# The one group that is removed recursively, and the largest thing here by far — an unpacked pi
# release is tens of megabytes. A preview that claims to be "the whole list" has to say so before
# the confirmation, not only in the removal log afterwards.
if [ -s "$TREES" ]; then
  printf '\n   %sunpacked runtime%s (%s) — removed whole, with everything inside it\n' \
    "$C_B" "$C_0" "$(count_of "$TREES")"
  while IFS=$'\t' read -r t_path t_what; do printf '     %-58s %s%s%s\n' "$t_path" "$C_D" "$t_what" "$C_0"; done < "$TREES"
  info "the pi binary itself lives in here; nothing you wrote does"
fi

if [ -s "$RCBLOCKS" ]; then
  printf '\n   %sshell rc blocks%s (%s) — only the fenced block, the rest of the file stays\n' \
    "$C_B" "$C_0" "$(count_of "$RCBLOCKS")"
  while IFS=$'\t' read -r r_path r_marker; do printf '     %-40s %s%s%s\n' "$r_path" "$C_D" "$r_marker" "$C_0"; done < "$RCBLOCKS"
fi

if [ -s "$NPMGLOBAL" ]; then
  printf '\n   %sglobal npm packages%s (%s) — installed with npm install -g, outside %s\n' \
    "$C_B" "$C_0" "$(count_of "$NPMGLOBAL")" "$PREFIX"
  while IFS=$'\t' read -r n_pkg n_why; do printf '     %-40s %s%s%s\n' "$n_pkg" "$C_D" "$n_why" "$C_0"; done < "$NPMGLOBAL"
  info "these are shared with the rest of npm on this machine — you are asked about them separately, below"
fi

if [ -s "$PATCHED" ]; then
  printf '\n   %sedited, but NOT removed%s (%s) — tracked repo files the installer changed\n' \
    "$C_B" "$C_0" "$(count_of "$PATCHED")"
  while IFS=$'\t' read -r p_path p_why; do printf '     %s\n' "$p_path"; done < "$PATCHED"
  info "restore them with:  git -C $REPO_DIR checkout -- config/"
fi

# ------------------------------------------------------------- the questions that matter ----
# Every one of these holds something the user produced, not something the installer produced.
# Each is asked on its own, with what it is and what losing it costs. Default is always keep.
step "3 of 4 — Your data: keep or remove"
if [ "$PURGE" = 1 ]; then
  info "--purge given: the default answer to each of these is REMOVE"
elif [ "$INTERACTIVE" = 0 ]; then
  info "--yes given (or no terminal): your credentials, sessions and other personal data below are"
  info "KEPT by default. The download cache and any global npm packages are removed anyway, same"
  info "as under a plain run — both are safe to lose, a re-install (or 'npm install -g') gets them back."
fi
[ -z "$FORCE_STATE" ] || info "the runtime state directory was pre-answered on the command line"
_def() { if [ "$PURGE" = 1 ]; then printf 'y'; else printf 'n'; fi; }

DEL_SECRETS=0; DEL_SESSIONS=0; DEL_DIGESTS=0; DEL_INDEX=0; DEL_AUTH=0; DEL_STATE=0; DEL_CACHE=0; DEL_BACKUPS=0; DEL_KEYCHAIN=0; DEL_NPMGLOBAL=0

_secrets_path="$SECRETS_FILE"
if [ -s "$SECRETS_ROWS" ]; then _secrets_path="$(head -n1 "$SECRETS_ROWS" | cut -f1)"; fi
if [ -f "$_secrets_path" ]; then
  printf '\n'
  info "$_secrets_path — your API keys and provider endpoints, in plain text (0600)."
  info "Removing it means re-entering every credential if you install again."
  if ask_yes_no "remove the secrets file?" "$(_def)"; then DEL_SECRETS=1; fi
fi

if [ -d "$AGENT_DIR/sessions" ]; then
  printf '\n'
  info "$AGENT_DIR/sessions — every transcript PI has ever written. PI's own data, not the installer's."
  if ask_yes_no "remove all session transcripts?" "$(_def)"; then DEL_SESSIONS=1; fi
fi

for _dg in "$AGENT_DIR/digests" "$AGENT_DIR/digest"; do
  if [ -d "$_dg" ]; then
    printf '\n'
    info "$_dg — the digest queue and its written digests (long-term memory of past sessions)."
    if ask_yes_no "remove the digests?" "$(_def)"; then DEL_DIGESTS=1; fi
    break
  fi
done

if [ -f "$AGENT_DIR/index.db" ]; then
  printf '\n'
  info "$AGENT_DIR/index.db — the local search index. Derived data: PI rebuilds it, slowly."
  if ask_yes_no "remove the search index?" "$(_def)"; then DEL_INDEX=1; fi
fi

if [ -f "$AGENT_DIR/auth.json" ] || [ -f "$AGENT_DIR/trust.json" ]; then
  printf '\n'
  info "$AGENT_DIR/auth.json, trust.json — PI's own OAuth tokens and your per-project trust decisions."
  info "The installer never wrote these. Removing them logs you out and re-asks trust for every repo."
  if ask_yes_no "remove PI's own auth and trust state?" "$(_def)"; then DEL_AUTH=1; fi
fi

if [ -d "$STATE_DIR" ]; then
  printf '\n'
  info "$STATE_DIR — runtime state: job store, worktree bookkeeping, compaction state, locks."
  if [ -n "$FORCE_STATE" ]; then
    # Pre-answered on the command line. Still announced, and still exactly one line, so a scripted
    # uninstall reads the same as an interactive one in a log.
    DEL_STATE="$FORCE_STATE"
    info "$( [ "$DEL_STATE" = 1 ] && printf 'rm -rf %s  (--purge-state)' "$STATE_DIR" || printf 'kept (--keep-state)' )"
  elif ask_yes_no "remove the runtime state directory?" "$(_def)"; then DEL_STATE=1; fi
fi

if [ -d "$CACHE_DIR" ]; then
  printf '\n'
  info "$CACHE_DIR — downloaded PI archives. Safe to remove; a re-install downloads them again."
  if ask_yes_no "remove the download cache?" y; then DEL_CACHE=1; fi
fi

if [ -s "$NPMGLOBAL" ]; then
  printf '\n'
  info "$(count_of "$NPMGLOBAL") package(s) install.sh put in npm's GLOBAL install tree, outside $PREFIX:"
  while IFS=$'\t' read -r n_pkg n_why; do printf '     %-40s %s%s%s\n' "$n_pkg" "$C_D" "$n_why" "$C_0"; done < "$NPMGLOBAL"
  info "That is shared with every other npm-based tool on this machine, not just this install, which"
  info "is why it gets its own question instead of going out with the symlinks. Safe to remove — this"
  info "is exactly the 'npm install -g' this installer ran, and re-running install.sh brings it back."
  info "Saying no leaves the package(s) on the machine; 'pi' may still work from a shell where npm's"
  info "global bin is on PATH even after everything else here is gone."
  if ask_yes_no "remove these global npm package(s)?" y; then DEL_NPMGLOBAL=1; fi
fi

if [ -s "$BACKUPS" ]; then
  printf '\n'
  info "$(count_of "$BACKUPS") backup file(s) the installer moved aside for you (*.bak.<timestamp>)."
  while IFS=$'\t' read -r b_path b_why; do
    if [ -e "$b_path" ]; then printf '     %s\n' "$b_path"; fi
  done < "$BACKUPS"
  if ask_yes_no "remove those backups?" "$(_def)"; then DEL_BACKUPS=1; fi
fi

if [ -s "$KEYCHAIN" ] && command -v security >/dev/null 2>&1; then
  printf '\n'
  info "macOS Keychain item(s) created for your credentials:"
  while IFS=$'\t' read -r k_svc k_why; do printf '     %-40s %s%s%s\n' "$k_svc" "$C_D" "$k_why" "$C_0"; done < "$KEYCHAIN"
  if ask_yes_no "delete those Keychain items?" "$(_def)"; then DEL_KEYCHAIN=1; fi
fi

# ------------------------------------------------------------------ final confirmation -----
if [ "$DRY_RUN" = 0 ] && [ "$INTERACTIVE" = 1 ]; then
  printf '\n'
  ask_yes_no "go ahead and remove everything listed above?" y || {
    printf '\nnothing was removed.\n'; exit 0; }
fi

# ======================================================================== 4. remove ==========
step "4 of 4 — Removing"

# --- symlinks. The target check is the safety property: a link somebody re-pointed at their own
# fork is not ours to delete, and saying so is more useful than silently leaving it.
while IFS=$'\t' read -r l_path l_target; do
  [ -n "$l_path" ] || continue
  if [ ! -L "$l_path" ] && [ ! -e "$l_path" ]; then ok "$(basename "$l_path") already gone"; continue; fi
  if [ ! -L "$l_path" ]; then
    warn "$l_path is a real file, not a symlink — refusing to delete it; move it aside by hand if that is what you want"
    continue
  fi
  _got="$(readlink "$l_path")"
  if [ -n "$l_target" ] && [ "$_got" != "$l_target" ]; then
    warn "$l_path points at '$_got', not at '$l_target' — someone re-pointed it; left alone"
    continue
  fi
  run "rm -- '$l_path'"
  gone "$l_path"
done < "$LINKS"

# --- generated config. The guard is not paranoia: a *.default.json is a tracked template, and
# deleting one turns `git status` dirty and the next install into a puzzle.
# shellcheck disable=SC2034  # g_why absorbs the manifest's trailing "why" column so it cannot end
# up appended to g_path. Unused by design.
while IFS=$'\t' read -r g_path g_why; do
  [ -n "$g_path" ] || continue
  case "$(basename "$g_path")" in
    *.default.json) warn "refusing to remove the shipped template $g_path"; continue ;;
  esac
  if [ -f "$g_path" ]; then run "rm -- '$g_path'"; gone "$g_path"
  else ok "$(basename "$g_path") already gone"; fi
done < "$GENERATED"

# --- rc blocks. Cut between the markers only; everything else in the file is untouched.
while IFS=$'\t' read -r r_path r_marker; do
  [ -n "$r_path" ] || continue
  [ -f "$r_path" ] || { ok "$(basename "$r_path") absent"; continue; }
  [ -n "$r_marker" ] || r_marker="$MARKER"
  # "# >>> NAME >>>" -> "# <<< NAME <<<". Derived rather than looked up, so a future block with a
  # new name is removed by the same code that removed this one.
  _name="${r_marker#\# >>> }"; _name="${_name% >>>}"
  _end="# <<< $_name <<<"
  if ! grep -qF "$r_marker" "$r_path" 2>/dev/null; then ok "$(basename "$r_path") has no '$_name' block"; continue; fi
  if [ "$DRY_RUN" = 0 ]; then
    # sed -i with an explicit suffix is the one spelling identical on BSD (macOS) and GNU sed.
    # The markers are matched literally, anchored, so a mention of them inside a comment elsewhere
    # in the file cannot start a deletion range.
    sed -i.pi-uninstall.bak "\\|^$r_marker\$|,\\|^$_end\$|d" "$r_path"
    rm -f "$r_path.pi-uninstall.bak"
  fi
  gone "$r_path: removed the '$_name' block"
done < "$RCBLOCKS"

# --- installer files. A FILE row for an rc file means the installer created that file; it is
# removed only if cutting our block left nothing but blank lines behind.
while IFS=$'\t' read -r f_path f_why; do
  [ -n "$f_path" ] || continue
  [ "$f_path" != "$MANIFEST" ] || continue   # the manifest goes last; it is still being read
  if [ ! -e "$f_path" ] && [ ! -L "$f_path" ]; then ok "$(basename "$f_path") already gone"; continue; fi
  case "$f_why" in
    "created by the installer"*)
      if [ -s "$f_path" ] && grep -qv '^[[:space:]]*$' "$f_path" 2>/dev/null; then
        # Under --dry-run our block is still in the file, so "it has content" is expected and
        # says nothing; only a real run can tell an empty leftover from a file you now own.
        if [ "$DRY_RUN" = 1 ]; then kept "$f_path — kept unless cutting our block leaves it empty"
        else kept "$f_path — the installer created it, but it has your own content in it now"; fi
        continue
      fi ;;
  esac
  run "rm -f -- '$f_path'"
  gone "$f_path"
done < "$FILES"

# --- personal data, each strictly on the answer given above.
if [ "$DEL_SECRETS" = 1 ]; then run "rm -f -- '$_secrets_path'"; gone "$_secrets_path (credentials)"
elif [ -f "$_secrets_path" ]; then kept "$_secrets_path — your credentials"; fi

if [ "$DEL_SESSIONS" = 1 ]; then run "rm -rf -- '$AGENT_DIR/sessions'"; gone "$AGENT_DIR/sessions"
elif [ -d "$AGENT_DIR/sessions" ]; then kept "$AGENT_DIR/sessions — transcripts"; fi

for _dg in "$AGENT_DIR/digests" "$AGENT_DIR/digest"; do
  [ -d "$_dg" ] || continue
  if [ "$DEL_DIGESTS" = 1 ]; then run "rm -rf -- '$_dg'"; gone "$_dg"; else kept "$_dg — digests"; fi
done

if [ -f "$AGENT_DIR/index.db" ]; then
  if [ "$DEL_INDEX" = 1 ]; then run "rm -f -- '$AGENT_DIR/index.db'"; gone "$AGENT_DIR/index.db"
  else kept "$AGENT_DIR/index.db — search index"; fi
fi

for _a in "$AGENT_DIR/auth.json" "$AGENT_DIR/trust.json"; do
  [ -f "$_a" ] || continue
  if [ "$DEL_AUTH" = 1 ]; then run "rm -f -- '$_a'"; gone "$_a"; else kept "$_a — PI's own state"; fi
done

if [ -d "$STATE_DIR" ]; then
  if [ "$DEL_STATE" = 1 ]; then run "rm -rf -- '$STATE_DIR'"; gone "$STATE_DIR"
  else kept "$STATE_DIR — runtime state"; fi
fi

if [ -d "$CACHE_DIR" ]; then
  if [ "$DEL_CACHE" = 1 ]; then run "rm -rf -- '$CACHE_DIR'"; gone "$CACHE_DIR"
  else kept "$CACHE_DIR — downloaded archives"; fi
fi

# --- global npm packages. The "is it actually still there" check runs for real even under
# --dry-run — it only reads npm's local metadata, nothing is changed by asking — so a package a
# previous partial run already removed is correctly reported as already gone instead of "would
# remove". A failed 'npm uninstall -g' is a warn + skip, never a die: half-finishing this and then
# aborting the rest of the uninstall over one shared-state package would be worse than leaving it.
if [ -s "$NPMGLOBAL" ]; then
  # shellcheck disable=SC2034  # n_why absorbs the manifest's trailing "why" column — see the note above.
  while IFS=$'\t' read -r n_pkg n_why; do
    [ -n "$n_pkg" ] || continue
    if [ "$DEL_NPMGLOBAL" != 1 ]; then
      kept "$n_pkg (global npm package) — remove by hand: npm uninstall -g -- '$n_pkg'"
      continue
    fi
    if ! command -v npm >/dev/null 2>&1; then
      warn "npm is not on PATH — cannot remove '$n_pkg'; once npm is available: npm uninstall -g -- '$n_pkg'"
      continue
    fi
    if ! npm ls -g --depth=0 "$n_pkg" >/dev/null 2>&1; then
      ok "$n_pkg already gone (not in npm's global tree)"
      continue
    fi
    if run "npm uninstall -g -- '$n_pkg' >/dev/null 2>&1"; then gone "$n_pkg (global npm package)"
    else warn "npm uninstall -g '$n_pkg' failed — remove it by hand: npm uninstall -g -- '$n_pkg'"; fi
  done < "$NPMGLOBAL"
fi

# --- trees install.sh unpacked whole (today: the pi runtime under
# $PREFIX/.local/share/pi-config/runtime/<version>).
# This is the only recursive delete driven by the manifest, so it is fenced twice: the row type has
# to be TREE, and the path has to still look like what install.sh writes — an absolute path, below
# the prefix, and not the prefix itself. A manifest that has been hand-edited into naming $HOME
# therefore removes nothing instead of removing everything.
if [ -s "$TREES" ]; then
  while IFS=$'\t' read -r t_path t_what; do
    [ -n "$t_path" ] || continue
    [ -d "$t_path" ] || continue
    case "$t_path" in
      "$PREFIX"|"$PREFIX"/) warn "$t_path — that is the install prefix itself, not a tree we unpacked"; continue ;;
      "$PREFIX"/*) : ;;
      *) warn "$t_path — outside the install prefix ($PREFIX); remove it by hand if it is ours"; continue ;;
    esac
    if run "rm -rf -- '$t_path'"; then gone "$t_path${t_what:+ — $t_what}"
    else warn "could not remove $t_path — remove it by hand: rm -rf -- '$t_path'"; fi
  done < "$TREES"
fi

if [ -s "$BACKUPS" ]; then
  while IFS=$'\t' read -r b_path b_why; do
    [ -e "$b_path" ] || continue
    if [ "$DEL_BACKUPS" = 1 ]; then run "rm -rf -- '$b_path'"; gone "$b_path"
    else kept "$b_path — backup of $b_why"; fi
  done < "$BACKUPS"
fi

if [ -s "$KEYCHAIN" ]; then
  while IFS=$'\t' read -r k_svc k_why; do
    [ -n "$k_svc" ] || continue
    if [ "$DEL_KEYCHAIN" = 1 ] && command -v security >/dev/null 2>&1; then
      if run "security delete-generic-password -s '$k_svc' >/dev/null 2>&1"; then gone "Keychain item $k_svc"
      else warn "Keychain item '$k_svc' could not be deleted (already gone, or locked) — check Keychain Access"; fi
    else kept "Keychain item $k_svc"; fi
  done < "$KEYCHAIN"
fi

# --- the manifest goes before the directory sweep, and only then: until this point it is the only
# record of what to do, and it lives inside one of the directories about to be swept.
if [ -f "$MANIFEST" ] && [ "$MANIFEST_FOUND" = 1 ]; then
  run "rm -f -- '$MANIFEST'"
  gone "$MANIFEST"
fi

# --- directories the installer created, removed only when empty. `rmdir` is the guard itself: it
# refuses a non-empty directory, so there is no branch here that can take somebody's files with it.
if [ -s "$DIRS" ]; then
  # Deepest first — longest path first — so ~/.pi/agent is emptied and removed before ~/.pi is
  # tried, and ~/.pi is therefore removable in the same pass rather than surviving as an orphan.
  while IFS= read -r d_path; do
    [ -n "$d_path" ] || continue
    [ -d "$d_path" ] || continue
    if [ "$DRY_RUN" = 1 ]; then info "$d_path would be removed if it ends up empty"; continue; fi
    if rmdir "$d_path" 2>/dev/null; then gone "$d_path (was empty)"
    else kept "$d_path — not empty, left in place"; fi
  done < <(awk '{ print length($0), $0 }' "$DIRS" | sort -rn | cut -d' ' -f2-)
fi

# ======================================================================= final report ========
printf '\n%s\n' "-----------------------------------------------------------------------"
if [ "$DRY_RUN" = 1 ]; then printf '  Would remove %s item(s), keep %s, skip %s\n' "$REMOVED" "$KEPT" "$SKIPPED"
else printf '  Removed %s item(s), kept %s, skipped %s\n' "$REMOVED" "$KEPT" "$SKIPPED"; fi
if [ "$SKIPPED" != 0 ]; then printf '  Each skip is printed above with the reason — nothing was deleted on a guess.\n'; fi

printf '\nStill on this machine:\n'
_residue() { if [ -e "$1" ] || [ -L "$1" ]; then printf '   PRESENT  %-44s %s\n' "$1" "$2"; fi; }
_residue "$REPO_DIR"                  "this checkout — delete it yourself when you are done"
_residue "$_secrets_path"             "your credentials"
_residue "$AGENT_DIR/sessions"        "transcripts"
_residue "$AGENT_DIR/auth.json"       "PI's own login"
_residue "$STATE_DIR"                 "runtime state"
_residue "$CACHE_DIR"                 "downloaded archives"
_residue "$REPO_DIR/node_modules"     "npm packages — 'rm -rf node_modules' if you are finished with the repo"
_residue "$BIN_DIR/pi"                "the PI binary — removed only if the installer put it there"

if [ -s "$PATCHED" ]; then
  printf '\nTracked files the installer edited (not removed, because they belong to the repo):\n'
  # shellcheck disable=SC2034  # p_why absorbs the trailing "why" column — see the note above.
  while IFS=$'\t' read -r p_path p_why; do printf '   %s\n' "$p_path"; done < "$PATCHED"
  printf '   restore them with:  git -C %s checkout -- config/\n' "$REPO_DIR"
fi

printf '\nOpen a new shell to drop the removed PATH entry.\n'
[ "$DRY_RUN" = 0 ] || printf '\n%sThis was a dry run — nothing above was actually removed.%s\n' "$C_CH" "$C_0"

# See the EXIT CODES block in the header (usage(), or run --help) for the contract this implements.
if [ "$SKIPPED" != 0 ]; then exit 3; fi
exit 0
