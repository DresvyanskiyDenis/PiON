#!/usr/bin/env bash
# auto-update-check.sh — is this checkout behind upstream? Write the answer down and stop.
#
# PiON — a hardened, portable harness for the PI coding agent.
#   https://dresvyanskiydenis.github.io/PiON/
#
# The contract: this script NOTICES, it never applies. `scripts/update.sh` is the only thing in
# this repository that moves the checkout, and it does so with the whole report on screen and one
# confirmation. Splitting the two is the point — a cron job that can fast-forward a tree while a
# session is reading it is a race with your own editor, and nobody asked for it at 03:00.
#
# What it does, in full: fetch `origin main`, count the commits between HEAD and it, and write
# `<agent-dir>/update-pending` when that count is above zero. The session-start half of the
# feature (`extensions/auto-update`) reads that file and tells you. Nothing else happens here.
#
# Properties, and why each one is what it is:
#   * quiet by contract  — cron mails every byte a job writes to stdout. A check that prints on
#                          success mails you 48 times a day until you delete it, so the normal
#                          paths say nothing at all. `--verbose` is for running it by hand.
#   * never fails a cron — every failure path exits 0 and records the reason in the log file
#                          named below. An exit 1 here buys nothing (cron does not retry) and
#                          costs a mail. The failure is still written down; it is not swallowed.
#   * opt-in             — with `config/auto-update.json` absent or `enabled: false` it exits
#                          immediately, having touched neither the network nor the flag file.
#                          The cron entry and the preference are installed together, but a
#                          hand-added entry against a disabled config is still a no-op.
#   * read-only on git   — `git fetch` writes only to `.git`. No checkout, no merge, no stash,
#                          no branch switch. A dirty tree is none of this script's business.
#   * counts, not equals — `HEAD != origin/main` is true on every feature branch ever created,
#                          which would report "an update is waiting" forever to anyone doing
#                          work. What is asked instead is `git rev-list --count HEAD..origin/main`:
#                          how many commits upstream has that this checkout does not. Zero on a
#                          feature branch cut from an up-to-date main, which is the honest answer.
#   * self-clearing      — a checkout that is no longer behind has its flag file removed. You
#                          pulled by hand, or on another machine sharing the tree; the reminder
#                          has to stop. update.sh clears the flag the moment it applies an
#                          update, so this path only ever catches the updates it did not do.
#
# Usage:
#   ./scripts/auto-update-check.sh              # what cron runs: silent unless something is wrong
#   ./scripts/auto-update-check.sh --verbose    # say what was found, on stdout
#   ./scripts/auto-update-check.sh --force      # ignore `enabled: false` and check anyway
#
# Flags:
#   --verbose | -v            print the outcome. Never use it in the cron entry
#   --force                   run even when auto-update is disabled in the config
#   -h | --help
#
# Exit codes:
#   0    always, on every path. See $STATE_DIR/auto-update-check.log for what went wrong
#
# Files:
#   config/auto-update.json                    the preference, written by scripts/install.sh
#   <agent-dir>/update-pending                 the flag, key=value, read by extensions/auto-update
#   $XDG_STATE_HOME/pi-config/auto-update-check.log   the last failure, one line, overwritten
#
# Docs: docs/getting-started/update.md
#       https://dresvyanskiydenis.github.io/PiON/getting-started/update/

set -uo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"

VERBOSE=0
FORCE=0

usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    -v|--verbose) VERBOSE=1; shift ;;
    --force)      FORCE=1; shift ;;
    -h|--help)    usage ;;
    *) printf 'auto-update-check: unknown argument %s\n' "$1" >&2; exit 0 ;;
  esac
done

PI_HOME="${PI_INSTALL_PREFIX:-$HOME}/.pi"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$PI_HOME/agent}"
FLAG_FILE="$AGENT_DIR/update-pending"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/pi-config"
LOG_FILE="$STATE_DIR/auto-update-check.log"

CONFIG_FILE="$REPO_DIR/config/auto-update.json"
[ -f "$CONFIG_FILE" ] || CONFIG_FILE="$REPO_DIR/config/auto-update.default.json"

say()  { [ "$VERBOSE" = 0 ] || printf '%s\n' "$*"; }
# One line, overwritten, never appended: this runs 48 times a day and an appended log is a disk
# leak nobody reads. The last failure is the one worth having.
note() {
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  printf '%s auto-update-check: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" > "$LOG_FILE" 2>/dev/null || true
  [ "$VERBOSE" = 0 ] || printf 'auto-update-check: %s\n' "$*" >&2
}

# The preference is read with node, not jq: jq is frequently absent on a locked-down machine and
# node is mandatory anyway — PI is a Node program. Same argument, same helper, as every other
# script in this directory. A config that will not parse is a failure, not a "false": saying
# "disabled" for a broken file would hide the breakage behind the feature's own off switch, and
# the reason it reports one word on stdout is so this script needs no second channel to read.
enabled_pref() {
  node -e '
    const fs = require("node:fs");
    try {
      const raw = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const cfg = raw.autoUpdate ?? {};
      process.stdout.write(cfg.enabled === true ? "enabled" : "disabled");
    } catch (err) {
      process.stdout.write(`error: ${err && err.message ? err.message : err}`);
    }
  ' "$CONFIG_FILE" 2>/dev/null
}

if ! command -v node >/dev/null 2>&1; then
  note "node is not on PATH (cron runs with a minimal PATH — check the entry)"
  exit 0
fi
ENABLED="$(enabled_pref)"
case "$ENABLED" in
  enabled|disabled) : ;;
  *) note "$CONFIG_FILE could not be read: $(printf '%s' "${ENABLED:-node produced no output}" | tr '\n' ' ' | cut -c1-300)"
     exit 0 ;;
esac

if [ "$ENABLED" != enabled ] && [ "$FORCE" = 0 ]; then
  say "auto-update is disabled in $CONFIG_FILE — nothing checked"
  exit 0
fi

if ! command -v git >/dev/null 2>&1; then
  note "git is not on PATH (cron runs with a minimal PATH — check the entry)"
  exit 0
fi
if ! git -C "$REPO_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  note "$REPO_DIR is not a git checkout — an update cannot be detected, let alone applied"
  exit 0
fi

# Errors are captured rather than discarded. `git fetch 2>/dev/null || exit 0` is the shape this
# check is usually written in, and it is why "my auto-update stopped working" is unanswerable:
# an expired credential, a proxy, a renamed remote and a laptop on a plane all look identical.
FETCH_ERR="$(git -C "$REPO_DIR" fetch --quiet origin main 2>&1)" || {
  note "git fetch origin main failed: $(printf '%s' "$FETCH_ERR" | tr '\n' ' ' | cut -c1-300)"
  exit 0
}

LOCAL="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)" || { note "cannot resolve HEAD"; exit 0; }
REMOTE="$(git -C "$REPO_DIR" rev-parse FETCH_HEAD 2>/dev/null)" || { note "cannot resolve FETCH_HEAD after a successful fetch"; exit 0; }
BEHIND="$(git -C "$REPO_DIR" rev-list --count "$LOCAL..$REMOTE" 2>/dev/null)" || { note "cannot count $LOCAL..$REMOTE"; exit 0; }

case "$BEHIND" in
  ''|*[!0-9]*) note "git rev-list returned '$BEHIND', which is not a count"; exit 0 ;;
esac

if [ "$BEHIND" -eq 0 ]; then
  # Not behind. If a flag is lying there from an earlier tick, the update it names has since been
  # applied by some route this script did not see. Remove it — see "self-clearing" above.
  if [ -f "$FLAG_FILE" ]; then
    rm -f "$FLAG_FILE" 2>/dev/null || true
    say "up to date — removed the stale $FLAG_FILE"
  else
    say "up to date"
  fi
  exit 0
fi

# key=value, the same shape as the answers file, for the same reason: one format in this
# repository for "a small record another program reads back", and no parser to get wrong.
if ! mkdir -p "$AGENT_DIR" 2>/dev/null; then
  note "cannot create $AGENT_DIR — the flag file has nowhere to go"
  exit 0
fi
{
  printf '# Written by scripts/auto-update-check.sh. Delete this file to dismiss the reminder.\n'
  printf 'range=%s..%s\n' "$LOCAL" "$REMOTE"
  printf 'commits=%s\n' "$BEHIND"
  printf 'checked=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$FLAG_FILE" 2>/dev/null || { note "cannot write $FLAG_FILE"; exit 0; }

say "$BEHIND commit(s) waiting on origin/main — wrote $FLAG_FILE"
exit 0
