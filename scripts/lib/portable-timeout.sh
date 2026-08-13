#!/usr/bin/env bash
# portable-timeout.sh — a wall-clock bound with no dependency on `timeout`/`gtimeout`.
#
# Neither exists on a stock macOS install (no coreutils, and Homebrew's `gtimeout` cannot be
# assumed either). A script that calls either bare is a real defect there, not a portability
# nicety. `install.sh` and `postinstall-verify.sh` source this file instead.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/lib/portable-timeout.sh"
#   run_with_timeout 30 some-command --with args
#   status=$?   # 124 on a real timeout, matching GNU `timeout`'s convention; else the command's
#               # own exit status.
#
# Mechanism: background the command, background a watchdog that SIGTERMs it at the deadline and
# SIGKILLs 2s later if it is still alive, `wait` for the command, then reap the watchdog so it
# never outlives the caller. Pure bash job control — no external binary required.

run_with_timeout() {
  local secs="$1"; shift
  [ "$#" -gt 0 ] || { echo "run_with_timeout: no command given" >&2; return 2; }

  "$@" &
  local pid=$!

  # A plain `kill "$pid"` only reaches the direct child — confirmed by hand: killing a
  # `bash -c 'sleep 30'` wrapper left `sleep 30` running as an orphan, because non-interactive
  # bash (no job control) never gives the background job its own process group. `set -m` fixes
  # that in principle, but it also changes `wait`'s exit-status reporting and job-control output
  # in ways that misfired here (verified: status came back 0 for a command that exited 3). The
  # reliable fix without depending on job control is `pkill -P` — kill anything the command
  # itself forked, one level down, which is the only nesting our actual callers (`pi`, `npm`,
  # `node`) produce.
  # < /dev/null > /dev/null 2>&1 on the watchdog itself: without it, this background subshell
  # inherits the caller's stdout/stderr and keeps holding them open for up to `secs + 2` seconds
  # even after the foreground command and this function have both returned. Any caller who pipes
  # this script's output (`./postinstall-verify.sh --json | jq .`, any CI capture) then blocks on
  # EOF for the full timeout window regardless of how fast the actual command ran — verified by
  # hand: a piped `--json` run hung for the check's whole timeout before this fix, every time.
  ( sleep "$secs"
    pkill -TERM -P "$pid" 2>/dev/null
    kill -TERM "$pid" 2>/dev/null
    sleep 2
    pkill -KILL -P "$pid" 2>/dev/null
    kill -KILL "$pid" 2>/dev/null
  ) < /dev/null > /dev/null 2>&1 &
  local watcher=$!
  disown "$watcher" 2>/dev/null

  # Not named `status`: that identifier is a reserved, read-only special parameter in zsh
  # (an alias for `$?`), and `local status` aborts with "read-only variable: status" if this
  # file is ever sourced into a zsh process instead of run as a bash script — verified by hand.
  local st
  if wait "$pid" 2>/dev/null; then st=0; else st=$?; fi

  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null

  # `wait` reports a killed child's exit status as 128+signal (143=SIGTERM, 137=SIGKILL).
  # Normalise both to 124 so callers can test "timed out" the same way GNU `timeout` reports it,
  # without caring which signal actually landed.
  if [ "$st" -eq 143 ] || [ "$st" -eq 137 ]; then st=124; fi
  return "$st"
}
