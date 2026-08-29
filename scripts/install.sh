#!/usr/bin/env bash
# install.sh — a bare machine -> a working PI coding agent, by answering questions.
#
# PiON — a hardened, portable harness for the PI coding agent.
#   git clone https://github.com/DresvyanskiyDenis/PiON.git
#
# The contract: when this script finishes, `pi` works. Not "works once you also export a
# variable", not "works after you edit three JSON files". Anything that genuinely cannot be
# automated is printed at the end as a numbered list of remaining manual steps — never left
# implicit, never left for the user to discover.
#
# It is also a teaching installer. Every section says what it is about to configure and why that
# matters, in one plain sentence, before asking. A user who reads nothing else should finish
# understanding roughly what they now have.
#
# Properties this script is required to have, and how each is achieved:
#   * ask, then confirm, then write — the whole interview happens first, a review screen shows
#                          every file that will be created, modified or symlinked and every line
#                          that will be appended to a shell rc, and one confirmation covers it.
#                          Ctrl-C before that point changes nothing at all.
#   * unattended capable — --yes/--defaults, --express, --answers FILE and $PI_INSTALL_ANSWERS
#                          drive the identical code path with zero prompts.
#   * idempotent         — every step reads the desired end state first and prints "ok" when it
#                          already holds. A second run on a converged machine changes 0 steps.
#   * re-runnable        — an existing install is detected and offered reconfigure / one section
#                          / repair / leave alone. Adding a provider six months later is a re-run,
#                          not a hand-edit.
#   * leaves no orphans  — every path it creates is appended to an install manifest that
#                          scripts/uninstall.sh reads back. One list, not two that drift.
#   * no admin           — writes only under the prefix ($HOME by default); never sudo.
#   * no secret in git   — credentials go to ~/.pi/secrets.env (0600) or the macOS Keychain.
#                          Config files carry only $VAR references. Re-checked against the
#                          generated files before the install is allowed to finish.
#   * fails loudly       — every exit path has a PI-INSTALL-Exx code, a named cause and an
#                          action. There is no bare `exit 1` and no silent skip.
#   * no piped shells    — never `curl ... | sh`; npm is always --ignore-scripts.
#
# Usage:
#   ./scripts/install.sh                          # the full interactive install
#   ./scripts/install.sh --express                # providers + safety only, defaults for the rest
#   ./scripts/install.sh --yes                    # unattended, accept every default
#   ./scripts/install.sh --answers my.conf --yes  # unattended, from a saved answer file
#   ./scripts/install.sh --dry-run                # print every action, change nothing
#   ./scripts/install.sh --prefix /tmp/pi-test --yes    # install into a throwaway tree
#   ./scripts/install.sh --reconfigure            # re-run the interview over an existing install
#   ./scripts/install.sh --repair                 # re-link and re-verify, ask nothing
#   ./scripts/install.sh --section maintenance    # just the auto-update check
#
# Flags:
#   --express                 short path: providers, credentials and the safety posture only
#   --yes | --defaults        never prompt; use answers/defaults, fail loudly if one is missing
#   --answers FILE            key=value answers (also $PI_INSTALL_ANSWERS)
#   --write-answers FILE      where this run's answers are saved (default: <agent-dir>/install-answers.conf)
#   --providers a,b           preselect providers, skipping the picker
#   --tier NAME=provider/id   preset one tier binding (repeatable)
#   --section NAME            reconfigure only one section:
#                             providers|tiers|agent|safety|tools|shell|maintenance
#   --prefix DIR              install root instead of $HOME (also $PI_INSTALL_PREFIX). Relocates the
#                             runtime tree only: the generated config/*.json is always written into
#                             THIS clone, so a throwaway install overwrites the real one's.
#   --mode auto|binary|npm    how PI itself is installed
#   --offline [--offline-dir D]   no network; artifacts are pre-staged in D
#   --skip-runtime            do not touch the PI binary; configure only
#   --skip-packages           do not run npm install for the packaged extensions
#   --no-shell                do not modify any shell rc file
#   --no-verify               skip the post-install verification step
#   --reconfigure | --repair  re-run modes (see above)
#   --dry-run                 print every action, perform none
#   -h | --help
#
# Docs: docs/getting-started/install.md
#       https://dresvyanskiydenis.github.io/PiON/getting-started/install/

set -euo pipefail

# =============================================================================== constants ===
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
LOCK="$REPO_DIR/config/pi-release.lock"
PROVIDERS_DIR="$REPO_DIR/config/providers"
LIB_JSON="$REPO_DIR/scripts/lib/json.mjs"
LIB_PROVIDERS="$REPO_DIR/scripts/lib/providers.mjs"
LIB_CONFIGURE="$REPO_DIR/scripts/lib/configure.mjs"

NODE_MIN="22.19.0"          # PI's own npm-path requirement
NODE_MIN_HELPERS="18.0.0"   # what scripts/lib/*.mjs themselves need

MARKER="# >>> pi-config >>>"
MARKER_END="# <<< pi-config <<<"
MARKER_H="# >>> pi-config (headless) >>>"
MARKER_H_END="# <<< pi-config (headless) <<<"

SECTIONS_TOTAL=9

# ==================================================================================== flags ===
MODE="auto"; OFFLINE=0; OFFLINE_DIR=""
RUN_VERIFY=1; DRY_RUN=0; ASSUME_YES=0; DO_SHELL=1; SKIP_RUNTIME=0; SKIP_PACKAGES=0
RECONFIGURE=0; REPAIR=0; EXPRESS=0; ONLY_SECTION=""
ANSWERS_IN="${PI_INSTALL_ANSWERS:-}"; ANSWERS_OUT=""; PRESELECT=""; CLI_TIERS=""
PREFIX="${PI_INSTALL_PREFIX:-$HOME}"

CHANGED=0
BACKUPS=""
MANUAL_TODO=""
SKIPPED=""
PLAN=""
APPLYING=0

# =================================================================================== output ===
# Colour only when a terminal is attached and NO_COLOR is unset — the same rule every other tool
# on the machine follows, so piping this script's output somewhere never produces escape codes.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_OK=$'\033[32m'; C_CH=$'\033[33m'; C_ER=$'\033[31m'; C_B=$'\033[1m'; C_D=$'\033[2m'; C_C=$'\033[36m'; C_0=$'\033[0m'
  S_OK="✔"; S_CH="+"; S_WARN="!"; S_INFO="·"
else
  C_OK=""; C_CH=""; C_ER=""; C_B=""; C_D=""; C_C=""; C_0=""
  S_OK="OK"; S_CH="+"; S_WARN="!"; S_INFO="-"
fi

SECTION_N=0
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
plan_add() { PLAN="$PLAN
     $*"; }
todo_add() { MANUAL_TODO="$MANUAL_TODO
$*"; }

# Prints the header block above: the line after the shebang up to the first line that is not a
# comment. Not a line range — the range this replaces ended at line 68, which is a bare `#`, so
# `--help` printed no link to the install documentation at all. update.sh had the same defect in a
# worse place (its exit-code table lost 130) and the same cause: a number that stays correct only
# while nobody edits the comment block above it.
usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"; exit 0; }

# ============================================================================ argument parse ===
while [ $# -gt 0 ]; do
  case "$1" in
    --express)        EXPRESS=1; shift ;;
    --yes|--defaults) ASSUME_YES=1; shift ;;
    --answers)        ANSWERS_IN="${2:?--answers needs a file}"; shift 2 ;;
    --write-answers)  ANSWERS_OUT="${2:?--write-answers needs a file}"; shift 2 ;;
    --providers)      PRESELECT="${2:?--providers needs a comma-separated list}"; shift 2 ;;
    --tier)           CLI_TIERS="$CLI_TIERS
${2:?--tier needs NAME=provider/model}"; shift 2 ;;
    --section)        ONLY_SECTION="${2:?--section needs a name}"; RECONFIGURE=1; shift 2 ;;
    --prefix)         PREFIX="${2:?--prefix needs a directory}"; shift 2 ;;
    --mode)           MODE="${2:?--mode needs auto|binary|npm}"; shift 2 ;;
    --offline)        OFFLINE=1; shift ;;
    --offline-dir)    OFFLINE_DIR="${2:?--offline-dir needs a directory}"; OFFLINE=1; shift 2 ;;
    --skip-runtime)   SKIP_RUNTIME=1; shift ;;
    --skip-packages)  SKIP_PACKAGES=1; shift ;;
    --no-shell)       DO_SHELL=0; shift ;;
    --no-verify)      RUN_VERIFY=0; shift ;;
    --reconfigure)    RECONFIGURE=1; shift ;;
    --repair)         REPAIR=1; ASSUME_YES=1; shift ;;
    --dry-run)        DRY_RUN=1; shift ;;
    -h|--help)        usage ;;
    *) die "PI-INSTALL-E01" "unknown argument '$1'" "run ./scripts/install.sh --help" ;;
  esac
done

# Every RUNTIME path hangs off $PREFIX, which is what makes a test install possible without going
# anywhere near a real ~/.pi. It is not full isolation, and the difference is announced below: the
# GENERATED config (config/models.json, routing.json, settings.json and their siblings) is written
# into this clone whatever --prefix says, because the live config is a symlink back into the repo
# by design. A throwaway install therefore overwrites the real one's generated config.
STABLE_LINK="$PREFIX/pi-config"
BIN_DIR="$PREFIX/bin"
PI_HOME="$PREFIX/.pi"
# $PI_CODING_AGENT_DIR is honoured ONLY for a normal install into $HOME. With --prefix the whole
# point is isolation, and an exported PI_CODING_AGENT_DIR pointing at the operator's live agent
# directory would quietly aim a throwaway test install straight at it. Measured, not theorised:
# the first sandbox run of this script did exactly that.
if [ "$PREFIX" = "$HOME" ]; then AGENT_DIR="${PI_CODING_AGENT_DIR:-$PI_HOME/agent}"
else AGENT_DIR="$PI_HOME/agent"; fi
SECRETS_FILE="$PI_HOME/secrets.env"
CACHE_DIR="$PREFIX/.cache/pi-install"
MANIFEST="$AGENT_DIR/install-manifest.tsv"
[ -n "$ANSWERS_OUT" ] || ANSWERS_OUT="$AGENT_DIR/install-answers.conf"

# Said out loud, at the top, before anything is written: --prefix reads as "isolated", and the one
# thing it does not isolate is the part a repo's own test suite reads back. Discovered by breaking
# eleven tests in a checkout whose routing.json a throwaway install had rewritten.
if [ "$PREFIX" != "$HOME" ]; then
  warn "--prefix moves the runtime tree, NOT the generated config: config/*.json is written into $REPO_DIR/config regardless"
  # The cleanup itself is a one-liner with nested quoting and a command substitution; printed
  # through the manual-step list it loses its quotes and stops being copy-pasteable, so the step
  # points at the place that carries it verbatim instead of trying to be it.
  todo_add "     this run rewrote $REPO_DIR/config/*.json (previous contents kept alongside as *.bak.*) — to restore that clone, run the cleanup command under 'Look before you leap' in docs/getting-started/install.md, then: ./scripts/install.sh --repair"
fi

# Interactive unless told otherwise AND a terminal is actually attached. Both halves matter: a
# CI job that forgot --yes must fail loudly on a missing answer, not block on a prompt forever.
INTERACTIVE=1
[ "$ASSUME_YES" = 0 ] || INTERACTIVE=0
{ [ -r /dev/tty ] && [ -t 0 ]; } || INTERACTIVE=0

# ============================================================================ scratch + traps ===
# Never /tmp: $TMPDIR is per-user on macOS, and mktemp -d keeps this run out of any other run's
# way. Removed on every exit path, including an interrupted one.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pi-install.XXXXXX")" || \
  die "PI-INSTALL-E21" "cannot create a scratch directory under ${TMPDIR:-/tmp}" \
      "check that \$TMPDIR exists and is writable"
ANSWERS="$SCRATCH/answers.conf"
: > "$ANSWERS"

# Every record stream this script writes and re-reads (provider list, credential plan, tier
# proposal, ...) is separated by US (0x1f), not by TAB. TAB is IFS whitespace, so `IFS=$'\t' read`
# silently merges two consecutive tabs and shifts every later field left — an empty column is
# indistinguishable from no column. US is not IFS whitespace, so one separator means one field
# even when the field is empty. Consequence for the rest of the file: `cut`/`awk` over these
# streams must be told the delimiter, because both default to TAB.
US="$(printf '\037')"

cleanup() { rm -rf -- "$SCRATCH"; }
on_interrupt() {
  trap - INT TERM
  printf '\n\n%sinterrupted%s\n' "$C_CH" "$C_0"
  if [ "$APPLYING" = 0 ]; then
    printf 'Nothing was written — the interview had not finished. Re-run when you are ready.\n'
  else
    printf 'The install was partway through. What it had already done is listed in:\n  %s\n' "$MANIFEST"
    printf 'Re-run ./scripts/install.sh to finish (it is idempotent), or ./scripts/uninstall.sh to back it out.\n'
  fi
  cleanup
  exit 130
}
trap cleanup EXIT
trap on_interrupt INT TERM

# ================================================================== answer store (bash 3.2) ===
# macOS ships bash 3.2, which has no associative arrays, so the answer map is a file in the
# `key=value` shape scripts/lib/providers.mjs already parses. That file IS the artifact --answers
# consumes on a later run, so there is exactly one format and no conversion step anywhere.
_ans_re() { printf '%s' "$1" | sed 's/[].[^$*\/]/\\&/g'; }
ans_set() { local tmp="$SCRATCH/ans.$$"
  grep -v "^$(_ans_re "$1")=" "$ANSWERS" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"; mv "$tmp" "$ANSWERS"; }
ans_get() { sed -n "s/^$(_ans_re "$1")=//p" "$ANSWERS" | tail -n1; }
# The inverse of ans_set. Used where a run has to be RE-asked a question it already has an answer
# to: ask() short-circuits on a stored key, so forgetting the key is how you get the prompt back.
ans_unset() { local tmp="$SCRATCH/ans.$$"
  grep -v "^$(_ans_re "$1")=" "$ANSWERS" > "$tmp" 2>/dev/null || true; mv "$tmp" "$ANSWERS"; }
ans_has() { grep -q "^$(_ans_re "$1")=" "$ANSWERS" 2>/dev/null; }

load_answer_file() { # load_answer_file <file> <overwrite 0|1>
  local f="$1" over="$2" line
  [ -f "$f" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*)
      if [ "$over" = 1 ] || ! ans_has "${line%%=*}"; then ans_set "${line%%=*}" "${line#*=}"; fi ;;
    esac
  done < "$f"
}

if [ -n "$ANSWERS_IN" ]; then
  [ -f "$ANSWERS_IN" ] || die "PI-INSTALL-E22" "--answers file '$ANSWERS_IN' does not exist" \
    "point it at a key=value file, or drop the flag and answer interactively"
  load_answer_file "$ANSWERS_IN" 1
fi
[ -z "$PRESELECT" ] || ans_set providers "$PRESELECT"
if [ -n "$CLI_TIERS" ]; then
  printf '%s\n' "$CLI_TIERS" | while IFS= read -r t; do
    [ -n "$t" ] || continue
    case "$t" in *=*) printf 'tier.%s=%s\n' "${t%%=*}" "${t#*=}" ;; esac
  done >> "$ANSWERS"
fi

# ================================================================================= prompting ===
# Reads from /dev/tty, not stdin, so prompting still works when the script itself is being fed
# something on stdin (a CI harness, a pipe).
# shellcheck disable=SC2229  # reading INTO the variable named by $1 is exactly the intent here
_read_tty() { local __v="$1"; IFS= read -r "$__v" < /dev/tty || eval "$__v=''"; }

ask_yes_no() { # ask_yes_no <question> <default y|n>
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

# Cheap, honest validation only: a URL must look like a URL, a port must be a port. Nothing here
# resolves a host or opens a socket — an installer that needs the network to validate an answer
# is useless on exactly the machines this repo targets.
# Every rejection message is indented and coloured like the rest of the interview, and goes to
# stderr so that a call site capturing the answer still shows the user why it was refused.
_verr() { printf '   %s%s%s\n' "$C_ER" "$1" "$C_0" >&2; return 1; }

validate() { # validate <type> <value> <choices-csv>
  local type="$1" val="$2" choices="${3:-}"
  case "$type" in
    url)
      case "$val" in http://*|https://*) : ;; *) _verr "must start with http:// or https://"; return 1 ;; esac
      case "${val#*://}" in ""|/*) _verr "there is no host after the scheme"; return 1 ;; esac ;;
    host)
      case "$val" in
        *://*|*/*) _verr "a bare host, no scheme and no path (e.g. github.example.com)"; return 1 ;;
        *" "*)     _verr "a host cannot contain a space"; return 1 ;;
        *.*|localhost) : ;;
        *) _verr "that does not look like a hostname"; return 1 ;;
      esac ;;
    decimal)
      # A price, not a count. 0, 2, 2.5 and 0.075 are all legal answers here and `int` rejects
      # three of them, so a rate typed correctly would be refused until the operator rounded it —
      # which is how an interview teaches someone to write down a number that is not the price.
      # Globs rather than a regex: this runs before the fragment's own ECMAScript pattern and must
      # be able to reject "abc" without node.
      case "$val" in
        ''|*[!0-9.]*|*.*.*|.*|*.)
          _verr "must be a number, with a leading digit and at most one decimal point (e.g. 0.075)"; return 1 ;;
      esac ;;
    port|int)
      case "$val" in ''|*[!0-9]*) _verr "must be a number"; return 1 ;; esac
      if [ "$type" = port ] && { [ "$val" -lt 1 ] || [ "$val" -gt 65535 ]; }; then
        _verr "a port is 1-65535"; return 1
      fi ;;
    path) case "$val" in "") _verr "cannot be empty"; return 1 ;; esac ;;
    enum)
      case ",$choices," in *",$val,"*) : ;;
        *) _verr "must be one of: $(printf '%s' "$choices" | sed 's/,/, /g')"; return 1 ;; esac ;;
    *) : ;;
  esac
  return 0
}

# ask <key> <label> <default> [type] [required 0|1] [choices-csv] [why] [regex] [regex-message]
# Precedence: an answer already in the store (--answers, or a previous run) > what is typed now
# > the default. The value is echoed on stdout AND stored, so callers can use either.
# The regex is an ECMAScript one straight out of a provider fragment, so it is evaluated by the
# engine that owns that dialect rather than approximated with a `case` glob.
#
# EVERY line this function puts on screen goes to stderr, and ONLY the answer goes to stdout.
# That split is load-bearing: call sites that do not need the return value write `>/dev/null`,
# and with the prompts on stdout that redirect ate the questions themselves — the user saw a
# silent hang, or a bare "must be one of: ..." from validate() with no question attached.
# Measured in a pty run, not theorised.
ask() {
  local key="$1" label="$2" def="$3" type="${4:-string}" required="${5:-1}" choices="${6:-}" why="${7:-}"
  local pattern="${8:-}" pattern_msg="${9:-}"
  local val=""
  if ans_has "$key"; then
    val="$(ans_get "$key")"
    if [ -n "$val" ] || [ "$required" = 0 ]; then
      info "$label = ${val:-<empty>}  (kept from your saved answers)" >&2
      printf '%s' "$val"; return 0
    fi
  fi
  if [ "$INTERACTIVE" = 0 ]; then
    val="$def"
    if [ -z "$val" ] && [ "$required" = 1 ]; then
      die "PI-INSTALL-E23" "no value for the required answer '$key' ($label), and no default to fall back on" \
          "add '$key=<value>' to your --answers file, or drop --yes and answer interactively"
    fi
    ans_set "$key" "$val"; printf '%s' "$val"; return 0
  fi
  printf '\n' >&2
  [ -z "$why" ] || printf '   %s%s%s\n' "$C_D" "$why" "$C_0" >&2
  [ -z "$choices" ] || printf '   %soptions: %s%s\n' "$C_D" "$(printf '%s' "$choices" | sed 's/,/, /g')" "$C_0" >&2
  while :; do
    if [ -n "$def" ]; then printf '   %s [%s]: ' "$label" "$def" >&2; else printf '   %s: ' "$label" >&2; fi
    _read_tty val; [ -n "$val" ] || val="$def"
    if [ -z "$val" ]; then
      [ "$required" = 0 ] && break
      printf '   %sthis one is required%s\n' "$C_ER" "$C_0" >&2; continue
    fi
    validate "$type" "$val" "$choices" || continue
    if [ -n "$pattern" ] && ! providers_tool match "$pattern" "$val"; then
      printf '   %s%s%s\n' "$C_ER" "${pattern_msg:-that does not match the required format}" "$C_0" >&2; continue
    fi
    break
  done
  ans_set "$key" "$val"; printf '%s' "$val"
}

# Never echoed, never stored in the answers file, never passed as a command-line argument.
# The label goes to stderr for the same reason as in ask(): the caller captures stdout.
ask_secret() { local label="$1" val=""
  printf '   %s (input is hidden): ' "$label" >&2
  IFS= read -r -s val < /dev/tty || val=""
  printf '\n' >&2; printf '%s' "$val"; }

# The theme list is the themes/ directory, not a copy of it kept here. `theme` selects by the
# `name` INSIDE each file, so that is what is read; a hand-maintained enum goes stale the first
# time a theme is added. jq when it is there, awk when it is not — the fallback pattern this
# script uses everywhere it reads JSON without a hard dependency on jq.
theme_choices() {
  local f name
  for f in "$REPO_DIR"/themes/*.json; do
    [ -e "$f" ] || continue
    if command -v jq >/dev/null 2>&1; then name="$(jq -r '.name' "$f")"
    else name="$(awk '/"name"[[:space:]]*:/ { sub(/^[^:]*:[[:space:]]*"/, ""); sub(/".*$/, ""); print; exit }' "$f")"
    fi
    [ -z "$name" ] || printf '%s,' "$name"
  done
  # PI's own two. They are not files, and nothing here replaces them.
  printf 'dark,light'
}

# ================================================================================== manifest ===
# The single source of truth for "what did the installer create". scripts/uninstall.sh reads it
# back, so the two scripts cannot drift the way two hand-maintained lists do.
manifest_add() { # manifest_add <TYPE> <PATH> [DETAIL]
  [ "$DRY_RUN" = 0 ] || return 0
  mkdir -p "$(dirname "$MANIFEST")" 2>/dev/null || true
  # De-duplicate on TYPE+PATH so a re-run does not grow the file without bound.
  if [ -f "$MANIFEST" ] && grep -qF "$(printf '%s\t%s\t' "$1" "$2")" "$MANIFEST" 2>/dev/null; then return 0; fi
  # A generated config is also, technically, patched — cfg_set() edits it. Recording that would
  # put one path into two of uninstall.sh's groups at once, "generated config (removed)" and
  # "edited, but NOT removed", which reads as a contradiction on its preview screen. GENERATED
  # wins: the installer created the file, so the installer may take it away.
  if [ "$1" = PATCHED ] && [ -f "$MANIFEST" ] && \
     grep -qF "$(printf 'GENERATED\t%s\t' "$2")" "$MANIFEST" 2>/dev/null; then return 0; fi
  printf '%s\t%s\t%s\n' "$1" "$2" "${3:-}" >> "$MANIFEST"
}

backup_file() { # backup_file <path> — move aside, record where, never overwrite in place
  local path="$1" dest
  [ -e "$path" ] || return 0
  dest="$path.bak.$(date +%Y%m%d%H%M%S)"
  run "mv '$path' '$dest'"
  BACKUPS="$BACKUPS
     $dest"
  manifest_add BACKUP "$dest" "was $path"
  warn "backed up $(basename "$path") -> $dest"
}

# ================================================================= template -> generated config ===
# Every config file this installer WRITES follows the same split, the one config/models.json and
# config/routing.json already used:
#
#     config/<name>.default.json   tracked in git   the repo's shipped template, never written
#     config/<name>.json           git-ignored      yours, generated from the template + answers
#
# The reason is not tidiness. Before the split these files were tracked AND patched in place, so
# every install dirtied the working tree, and whatever was on that machine — a workspace host, a
# home directory, a chosen default model — became the next commit in anyone's fork. Measured, not
# theorised: a --prefix test run wrote a scratch directory into config/trusted-roots.json, and it
# survived into the working copy.
GENERATED_CONFIGS="settings guard trusted-roots path-defaults web web-search quota subagent auto-update"

cfg_seed() { # cfg_seed <name> — a path that exists NOW, so the interview can read current values
  local live="$REPO_DIR/config/$1.json"
  if [ -f "$live" ]; then printf '%s' "$live"; else printf '%s/config/%s.default.json' "$REPO_DIR" "$1"; fi
}

materialize() { # materialize <name> — put config/<name>.json in place, from its template, once
  local live="$REPO_DIR/config/$1.json" def="$REPO_DIR/config/$1.default.json"
  if [ -f "$live" ]; then
    # An existing generated file is the user's, including any hand edit: patch it, never reset it
    # to the template. This is also what makes a re-run report 0 changes.
    manifest_add GENERATED "$live" "generated from $1.default.json + your answers"
    return 1
  fi
  [ -f "$def" ] || die "PI-INSTALL-E30" "config/$1.default.json is missing from this checkout" \
      "re-clone the repository — the shipped config templates are incomplete"
  run "cp '$def' '$live'"
  manifest_add GENERATED "$live" "generated from $1.default.json + your answers"
  return 0
}

# ============================================================================ helper wrappers ===
json()      { node "$LIB_JSON" "$@"; }
providers_tool() { node "$LIB_PROVIDERS" "$@"; }
# cfg_set <file> <path=value>... — patch a JSON config in place, reporting ok/changed honestly.
cfg_set() {
  local file="$1"; shift
  # A whole-array value can be several lines long; the log wants one readable line. The `str:` and
  # `json:` prefixes are configure.mjs's type-forcing syntax, not part of the value — showing them
  # to the user ("externalEditor=str:code --wait") reads like a typo in their own answer.
  local what; what="$(printf '%s ' "$@" | tr '\n' ' ' | tr -s ' ' | sed 's/=str:/=/g; s/=json:/=/g')"
  # Clamp with a visible ellipsis, not a bare cut: a line that stops mid-word ("externalEdito")
  # reads as a corrupted value rather than as a shortened log line.
  [ "${#what}" -le 110 ] || what="$(printf '%.107s...' "$what")"
  if [ "$DRY_RUN" = 1 ]; then printf '   %sdry-run%s patch %s: %s\n' "$C_D" "$C_0" "$(basename "$file")" "$what"; return 0; fi
  if node "$LIB_CONFIGURE" set "$file" "$@" >/dev/null; then
    changed "$(basename "$file"): $what"
    manifest_add PATCHED "$file" "modified by install.sh"
  else
    ok "$(basename "$file") already has: $what"
  fi
}

# ======================================================================== SECTION 1: preflight ===
printf '\n%s%s  PiON installer  %s\n' "$C_B" "$C_C" "$C_0"
printf '%sPiON — a hardened, portable harness for the PI coding agent.%s\n' "$C_D" "$C_0"
printf '%sIt installs the PI coding agent, wires this repository into ~/.pi/agent, and asks you\n' "$C_D"
printf 'for the handful of things that are specific to your machine and your accounts.%s\n' "$C_0"
printf '\nrepo:   %s\n' "$REPO_DIR"
[ "$PREFIX" = "$HOME" ] || printf 'prefix: %s (not $HOME)\n' "$PREFIX"
[ "$DRY_RUN" = 0 ] || printf '%sdry run: every action is printed, nothing is written%s\n' "$C_CH" "$C_0"
[ "$OFFLINE" = 0 ] || printf 'offline mode: no network will be used\n'
[ "$INTERACTIVE" = 1 ] || printf 'non-interactive: defaults and --answers only\n'

section "Checking your machine" \
  "Nothing is written in this step. It only confirms the tools the rest of the install needs."

# bash 3.2 is what stock macOS ships and is therefore the floor. Nothing in this script uses a
# bash 4 feature (no declare -A, no \${var^^}, no readarray) — a maintenance rule, and this
# check is what makes the rule observable.
[ "${BASH_VERSINFO[0]:-0}" -ge 3 ] || \
  die "PI-INSTALL-E02" "bash ${BASH_VERSION:-?} is too old (need >= 3.2)" \
      "run it explicitly with a newer bash: bash ./scripts/install.sh"

[ "$(id -u)" != "0" ] || \
  die "PI-INSTALL-E07" "you are running as root" \
      "everything here is written under $PREFIX — re-run as your normal user, without sudo"

[ -d "$PREFIX" ] || run "mkdir -p '$PREFIX'"
{ [ -w "$PREFIX" ] || [ "$DRY_RUN" = 1 ]; } || \
  die "PI-INSTALL-E08" "the install prefix '$PREFIX' is not writable" \
      "pick another one with --prefix, or fix its permissions"

[ -f "$LOCK" ] || \
  die "PI-INSTALL-E09" "missing $LOCK" \
      "you are not inside a complete PiON clone — re-clone: git clone https://github.com/DresvyanskiyDenis/PiON.git"

for t in tar ln readlink sed awk grep; do
  command -v "$t" >/dev/null 2>&1 || \
    die "PI-INSTALL-E10" "the required tool '$t' is not on PATH" \
        "install your platform's coreutils/tar package; several steps below shell out to it"
done
ok "shell tools: tar ln readlink sed awk grep"

# jq is NOT required by this installer — every JSON read here goes through Node — but it is
# required by the first thing a colleague does afterwards: config/bin/pi-tier hard-requires it,
# and docs/getting-started/first-run.md step 2 is `pi-tier --list`. Without this check the
# install completes clean, postinstall-verify.sh passes (it deliberately avoids jq), and the
# failure surfaces at first run as a message about a tool the installer never mentioned.
# A warning and a named manual step rather than an abort: nothing installed here stops working
# without jq, and on macOS the whole remedy is one brew command.
if command -v jq >/dev/null 2>&1; then
  ok "jq $(jq --version 2>/dev/null | tr -d '\n') — pi-tier and the provider verification one-liners need it"
else
  warn "'jq' is not on PATH. The installer does not need it; pi-tier and the per-provider verification one-liners do"
  todo_add "     install jq (macOS: brew install jq — Debian/Ubuntu: apt install jq), or 'pi-tier --list' will not run"
fi

# Node is a hard prerequisite even on the standalone-binary path: bin/pi-check, bin/pi-run and
# this installer's own JSON handling are all Node. Refusing here, with an actionable message,
# beats failing three steps later inside a helper.
command -v node >/dev/null 2>&1 || \
  die "PI-INSTALL-E04" "'node' is not on PATH, and this harness cannot work without it" \
      "install Node >= $NODE_MIN from https://nodejs.org, or with a user-space manager (mise, fnm, nvm), then re-run"
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]; }
NODE_VERSION="$(node --version 2>/dev/null | tr -d 'v \n')"
version_ge "$NODE_VERSION" "$NODE_MIN_HELPERS" || \
  die "PI-INSTALL-E04" "node $NODE_VERSION is older than the $NODE_MIN_HELPERS these install scripts need" \
      "upgrade Node to >= $NODE_MIN (what PI itself wants on the npm path) and re-run"
if version_ge "$NODE_VERSION" "$NODE_MIN"; then ok "node $NODE_VERSION (>= $NODE_MIN)"
else warn "node $NODE_VERSION is below PI's own $NODE_MIN — fine for --mode binary, blocks --mode npm"; fi

if command -v npm >/dev/null 2>&1; then ok "npm $(npm --version 2>/dev/null)"
else
  warn "npm is not on PATH — fine for --mode binary; --mode npm and the optional LSP installs need it"
fi

for f in "$LIB_JSON" "$LIB_PROVIDERS" "$LIB_CONFIGURE"; do
  [ -f "$f" ] || die "PI-INSTALL-E09" "missing $f" "re-clone the repository; the installer's helpers are part of it"
done

PI_VERSION_EXPECTED="$(json get "$LOCK" version || true)"
[ -n "$PI_VERSION_EXPECTED" ] || \
  die "PI-INSTALL-E09" "config/pi-release.lock has no .version" "restore the lock file from git"
ok "pinned pi version: $PI_VERSION_EXPECTED"

if [ "$OFFLINE" = 1 ] && [ -n "$OFFLINE_DIR" ] && [ ! -d "$OFFLINE_DIR" ]; then
  die "PI-INSTALL-E11" "--offline-dir '$OFFLINE_DIR' does not exist" \
      "point it at the directory holding the pre-staged pi-*.tar.gz artifacts"
fi

case "$(uname -s) $(uname -m)" in
  "Darwin arm64")   PLATFORM="darwin-arm64" ;;
  "Darwin x86_64")  PLATFORM="darwin-x64" ;;
  "Linux x86_64")   PLATFORM="linux-x64" ;;
  "Linux aarch64")  PLATFORM="linux-arm64" ;;
  *) PLATFORM="unsupported" ;;
esac
IS_MACOS=0; [ "$(uname -s)" = "Darwin" ] && IS_MACOS=1
ok "platform $(uname -s) $(uname -m) -> $PLATFORM"

if [ "$MODE" = "auto" ]; then
  if [ "$PLATFORM" = "unsupported" ]; then MODE="npm"
    warn "no standalone binary is published for this platform — using --mode npm"
  else MODE="binary"; fi
fi
{ [ "$MODE" = "binary" ] || [ "$MODE" = "npm" ]; } || \
  die "PI-INSTALL-E01" "--mode '$MODE' is not one of auto|binary|npm" "re-run with a valid --mode"
ok "PI will be installed as: $MODE"

# ==================================================================== SECTION 2: existing install ===
section "Looking for an existing install" \
  "Re-running this script is a supported, normal thing to do. Nothing is overwritten without asking."

INSTALLED_PI_VERSION="$("$BIN_DIR/pi" --version 2>/dev/null | tr -d 'v \n' || true)"
HAVE_GENERATED_CONFIG=0; [ -f "$REPO_DIR/config/models.json" ] && HAVE_GENERATED_CONFIG=1
HAVE_LINKS=0; [ -L "$AGENT_DIR/settings.json" ] && HAVE_LINKS=1

if [ "$HAVE_GENERATED_CONFIG" = 1 ] || [ "$HAVE_LINKS" = 1 ] || [ -n "$INSTALLED_PI_VERSION" ]; then
  ok "found an install: pi=${INSTALLED_PI_VERSION:-none}, generated config=$HAVE_GENERATED_CONFIG, symlinks=$HAVE_LINKS"
  if [ -f "$ANSWERS_OUT" ] && [ -z "$ANSWERS_IN" ]; then
    load_answer_file "$ANSWERS_OUT" 0
    info "your previous answers were loaded from $ANSWERS_OUT — Enter keeps each one"
  fi
  if [ "$REPAIR" = 1 ]; then ok "--repair: keeping every previous answer; re-link, regenerate, verify"
  elif [ -n "$ONLY_SECTION" ]; then ok "--section $ONLY_SECTION: only that section is re-asked"
  elif [ "$RECONFIGURE" = 1 ]; then ok "--reconfigure: the full interview runs again"
  elif [ "$INTERACTIVE" = 1 ]; then
    printf '\n   %sWhat should this run do?%s\n' "$C_B" "$C_0"
    printf '     1) reconfigure everything  — the full interview, your answers pre-filled\n'
    printf '     2) reconfigure one section — providers, tiers, agent, safety, tools, shell or maintenance\n'
    printf '     3) repair                  — re-link and re-verify, ask nothing\n'
    printf '     4) leave it alone          — exit now, change nothing\n'
    _ex=""
    while :; do
      printf '   choice [3]: '; _read_tty _ex; [ -n "$_ex" ] || _ex=3
      case "$_ex" in
        1) RECONFIGURE=1; break ;;
        2) printf '   which section? [providers|tiers|agent|safety|tools|shell|maintenance]: '
           _read_tty ONLY_SECTION
           case "$ONLY_SECTION" in
             providers|tiers|agent|safety|tools|shell|maintenance) RECONFIGURE=1; break ;;
             *) printf '   %sunknown section%s\n' "$C_ER" "$C_0"; ONLY_SECTION="" ;;
           esac ;;
        3) REPAIR=1; break ;;
        4) printf '\nnothing was changed.\n'; exit 0 ;;
        *) printf '   %s1, 2, 3 or 4%s\n' "$C_ER" "$C_0" ;;
      esac
    done
  else
    ok "non-interactive re-run — treated as repair + regenerate"
    REPAIR=1
  fi
else
  ok "no previous install found — this is a first-time install"
fi

# ask_section <name> — is this section's interview active this run?
ask_section() {
  [ "$REPAIR" = 0 ] || return 1
  [ -z "$ONLY_SECTION" ] || [ "$ONLY_SECTION" = "$1" ] || return 1
  return 0
}

# The express path. Offered once, early, before any of the long sections.
if [ "$EXPRESS" = 0 ] && [ "$INTERACTIVE" = 1 ] && [ "$REPAIR" = 0 ] && [ -z "$ONLY_SECTION" ]; then
  printf '\n   %sHow much do you want to be asked?%s\n' "$C_B" "$C_0"
  printf '     1) full    — every setting, with an explanation. About 5 minutes  (recommended)\n'
  printf '     2) express — providers, credentials and the safety posture only; sensible defaults\n'
  printf '                  for everything else. About 2 minutes. Re-run any time to go deeper\n'
  _mode=""
  while :; do
    printf '   choice [1]: '; _read_tty _mode; [ -n "$_mode" ] || _mode=1
    case "$_mode" in 1) EXPRESS=0; break ;; 2) EXPRESS=1; break ;; *) printf '   %s1 or 2%s\n' "$C_ER" "$C_0" ;; esac
  done
fi
[ "$EXPRESS" = 0 ] || ok "express path selected"

# ======================================================================== SECTION 3: providers ===
section "Providers and credentials" \
  "A provider is where the models come from. Pick the ones you have access to; the rest can be added later by re-running this script."

PROVIDER_LIST="$SCRATCH/providers.tsv"
if ! providers_tool list "$PROVIDERS_DIR" > "$PROVIDER_LIST" 2>"$SCRATCH/providers.err"; then
  if [ -s "$SCRATCH/providers.err" ]; then
    die "PI-INSTALL-E24" "cannot read the provider templates in $PROVIDERS_DIR: $(tail -1 "$SCRATCH/providers.err")" \
        "each config/providers/*.json must be a JSON object — fix or remove the offending file"
  fi
  die "PI-INSTALL-E24" "no provider templates found in $PROVIDERS_DIR" \
      "this repository ships one config/providers/<name>.json per supported provider; re-clone, or add one (the shape is documented in config/providers/README.md)"
fi
N_PROVIDERS="$(wc -l < "$PROVIDER_LIST" | tr -d ' ')"
ok "$N_PROVIDERS provider template(s) shipped with this repo"

SELECTED="$(ans_get providers | tr ',' ' ')"
if ask_section providers && { [ -z "$SELECTED" ] || [ "$RECONFIGURE" = 1 ]; } && [ "$INTERACTIVE" = 1 ]; then
  printf '\n'
  _i=0
  while IFS=$'\037' read -r p_id p_name p_egress p_default p_desc; do
    [ -n "$p_id" ] || continue
    _i=$((_i + 1))
    printf '     %d) %-22s %s%s\n' "$_i" "$p_id" "$p_name" \
      "$( [ "$p_default" = 1 ] && printf ' %s(recommended default)%s' "$C_OK" "$C_0" )"
    [ -z "$p_desc" ] || printf '        %s%s%s\n' "$C_D" "$p_desc" "$C_0"
    # Show the egress class while the choice is being made, not afterwards in a config file. It is
    # a label and refuses nothing (the containment rule that used to enforce it was withdrawn on
    # 2026-08-13), so the only moment it can influence anything is the moment a human picks the
    # provider -- which is exactly this prompt.
    printf '        %swhere the data goes: %s%s\n' "$C_D" "$p_egress" "$C_0"
  done < "$PROVIDER_LIST"
  _prev="$(ans_get providers)"
  printf '\n'
  while :; do
    printf '   numbers, comma-separated%s: ' "$( [ -n "$_prev" ] && printf ' [keep: %s]' "$_prev" || printf ' [1]' )"
    _sel=""; _read_tty _sel
    if [ -z "$_sel" ] && [ -n "$_prev" ]; then SELECTED="$(printf '%s' "$_prev" | tr ',' ' ')"; break; fi
    [ -n "$_sel" ] || _sel=1
    SELECTED=""; _bad=0
    for _n in $(printf '%s' "$_sel" | tr ',' ' '); do
      case "$_n" in ''|*[!0-9]*) _bad=1; break ;; esac
      _line="$(sed -n "${_n}p" "$PROVIDER_LIST")"
      [ -n "$_line" ] || { _bad=1; break; }
      SELECTED="$SELECTED $(printf '%s' "$_line" | cut -d"$US" -f1)"
    done
    { [ "$_bad" = 0 ] && [ -n "$SELECTED" ]; } && break
    printf '   %spick from 1..%s%s\n' "$C_ER" "$N_PROVIDERS" "$C_0"
  done
elif [ -z "$SELECTED" ]; then
  # `list` sorts the fragment marked `default: true` first, so this is the fragment that declares
  # itself the zero-configuration choice, not just whatever sorted first alphabetically.
  SELECTED="$(head -n1 "$PROVIDER_LIST" | cut -d"$US" -f1)"
  warn "no provider chosen and none saved; using the fragment that declares itself the default: $SELECTED"
fi

SELECTED="$(printf '%s' "$SELECTED" | tr -s ' ' | sed 's/^ //;s/ $//')"
for p in $SELECTED; do
  grep -q "^$p$(printf '\037')" "$PROVIDER_LIST" || \
    die "PI-INSTALL-E25" "'$p' is not one of the available providers" \
        "available: $(cut -d"$US" -f1 "$PROVIDER_LIST" | tr '\n' ' ')"
done
ans_set providers "$(printf '%s' "$SELECTED" | tr ' ' ',')"
ok "providers: $SELECTED"
plan_add "generate config/models.json for: $SELECTED"

CRED_PLAN="$SCRATCH/credentials.tsv"; : > "$CRED_PLAN"
MODEL_CHOICES="$SCRATCH/models.tsv";  : > "$MODEL_CHOICES"
TIER_SUGGESTIONS="$SCRATCH/tiersugg.tsv"; : > "$TIER_SUGGESTIONS"
ENV_PLAN="$SCRATCH/envplan.tsv"; : > "$ENV_PLAN"
NOTES_LOG="$SCRATCH/provider-notes.md"; : > "$NOTES_LOG"
VERIFY_ANY=0

for p in $SELECTED; do
  printf '\n   %s--- %s ---%s\n' "$C_B" "$p" "$C_0"
  DESC="$SCRATCH/desc.$p.tsv"
  providers_tool describe "$PROVIDERS_DIR" "$p" > "$DESC" 2>"$SCRATCH/desc.err" || \
    die "PI-INSTALL-E24" "config/providers/$p.json was rejected: $(tail -1 "$SCRATCH/desc.err")" \
        "fix the fragment against config/providers/README.md — the contract is normative, the installer is not"
  printf '\n## %s\n\n' "$p" >> "$NOTES_LOG"

  # describe -> ask, in fragment order. `when` is evaluated here rather than in the generator so
  # that a question the user cannot meaningfully answer is never put on screen at all.
  while IFS=$'\037' read -r kind f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 f11 f12 f13; do
    case "$kind" in
      META)
        info "$f1 — $f2"
        info "egress class: $f3   concurrency cap: $f4   $( [ "$f5" = 1 ] && printf 'PI ships this provider; the fragment only overrides parts of it' || printf 'defined entirely by this fragment' )" ;;
      NOTE)
        # README §2.6: the notes carry measured facts (which compat flag causes which 400, why a
        # credential path was chosen). They go into the install log for every selected fragment,
        # and on the full path onto the screen, because they are the reason the config looks
        # the way it does.
        printf -- '- %s\n' "$f1" >> "$NOTES_LOG"
        # On screen: the headline only — the note's first sentence, capped. A fragment's notes run
        # to a dozen dense paragraphs (they carry measured findings, e.g. which compat flag causes
        # which 400), and printing all of them before the first question is a wall of text, not
        # teaching. The full text is kept verbatim and written to provider-notes.md at the end.
        #
        # The headlines print on EVERY path, --express and --yes included. They were once behind
        # an $EXPRESS guard, and the note it suppressed most consequentially was
        # github-copilot's "NEVER RUN /login github-copilot WITH THIS FRAGMENT" — whose cost when
        # missed is not an error but an enterprise tenant's traffic silently leaving it, because
        # PI's OAuth resolver overrides the configured baseUrl at request time. A note whose whole
        # content is "never do X" is not a verbosity setting. One capped line per note is not the
        # wall of text the guard was defending against; the full paragraphs still are, and they
        # still only go to the file.
        _nhead="${f1%%. *}"
        [ "${#_nhead}" -le 108 ] || _nhead="$(printf '%.105s...' "$_nhead")"
        printf '   %s· %s%s\n' "$C_D" "$_nhead" "$C_0"
        NOTES_SHOWN=1 ;;
      REQ)
        # f1=kind f2=name f3=required f4=secret f5=description f6=howTo
        case "$f1" in
          command)
            if command -v "$f2" >/dev/null 2>&1; then ok "needs '$f2' — found at $(command -v "$f2")"
            else
              # README §2.1 is explicit that a missing requirement is a warning, never fatal: the
              # provider's models simply become unavailable and the harness must still start. It
              # is loud, named, and lands in the manual-steps list — not silent.
              warn "'$f2' is not on PATH. $f5"
              todo_add "     install '$f2' for the $p provider — ${f6:-see config/providers/$p.json}"
            fi ;;
          service)
            info "expects a running service: $f2. $f5"
            todo_add "     make sure '$f2' is running before you use the $p provider — ${f6:-see config/providers/$p.json}" ;;
          env)
            if [ "$f4" = 1 ]; then printf '%s\037%s\037%s\037%s\037%s\037%s\n' "$p" "$f2" "$f5" "$f3" "" "$f6" >> "$CRED_PLAN"
            else info "will need \$$f2 exported — asked for below" ; fi ;;
        esac ;;
      PROMPT)
        # f1=id f2=type f3=label f4=default f5=required f6=choices f7=choiceLabels
        # f8=whenId f9=whenValue f10=pattern f11=patternMessage f12=help f13=example
        _skip=0
        if [ -n "$f8" ]; then
          _dep="$(ans_get "$p.$f8")"
          if [ "$f9" = "*" ]; then [ -n "$_dep" ] || _skip=1
          else [ "$_dep" = "$f9" ] || _skip=1; fi
        fi
        if [ "$_skip" = 1 ]; then
          # Not asked, and not silently left undefined either: the generator applies the same rule
          # and would use the fragment's own default, so record that here and keep the two in step.
          ans_set "$p.$f1" "$f4"
          continue
        fi
        if ! ask_section providers; then
          info "$f3 = $(ans_get "$p.$f1" 2>/dev/null || true)${_kept:-}$( [ -n "$(ans_get "$p.$f1")" ] || printf '<fragment default: %s>' "${f4:-none}" )"
          continue
        fi
        _why="$f12"
        [ -z "$f13" ] || _why="${_why:+$_why }e.g. $f13"
        [ -z "$f7" ] || printf '\n   %s%s%s\n' "$C_D" "$f7" "$C_0"
        case "$f2" in
          choice)  ask "$p.$f1" "$f3" "$f4" enum "$f5" "$f6" "$_why" "" "" >/dev/null ;;
          boolean) ask "$p.$f1" "$f3" "${f4:-false}" enum "$f5" "true,false" "$_why" "" "" >/dev/null ;;
          port)    ask "$p.$f1" "$f3" "$f4" port "$f5" "" "$_why" "$f10" "$f11" >/dev/null ;;
          number)  ask "$p.$f1" "$f3" "$f4" int  "$f5" "" "$_why" "$f10" "$f11" >/dev/null ;;
          decimal) ask "$p.$f1" "$f3" "$f4" decimal "$f5" "" "$_why" "$f10" "$f11" >/dev/null ;;
          *)       ask "$p.$f1" "$f3" "$f4" string "$f5" "" "$_why" "$f10" "$f11" >/dev/null ;;
        esac ;;
    esac
  done < "$DESC"

  # resolve: what those answers actually produced. Separate from describe because it cannot run
  # until the questions above have been answered.
  RES="$SCRATCH/resolve.$p.tsv"
  providers_tool resolve "$PROVIDERS_DIR" "$p" "$ANSWERS" > "$RES" 2>"$SCRATCH/resolve.err" || \
    die "PI-INSTALL-E24" "provider '$p' could not be resolved from your answers: $(tail -1 "$SCRATCH/resolve.err")" \
        "re-run and check the answers for '$p'; the fragment's own substitution rules are in config/providers/README.md §3"
  while IFS=$'\037' read -r kind r1 r2 r3 r4 r5 r6; do
    case "$kind" in
      MODEL) printf '%s\037%s\n' "$r1" "$r2" >> "$MODEL_CHOICES" ;;
      TIER)  printf '%s\037%s\n' "$r1" "$r2" >> "$TIER_SUGGESTIONS" ;;
      ENV)   printf '%s\037%s\037%s\037%s\037%s\n' "$p" "$r1" "$r2" "$r3" "$r4" >> "$ENV_PLAN" ;;
      # A credential whose VARIABLE NAME the user chose. It arrives here rather than as a REQ row
      # above because `describe` runs before the first question — see providers.mjs. From this
      # point it is an ordinary secret: same plan row, same 1/2/3 menu, same secrets.env.
      # r1=kind r2=name r3=required r4=secret r5=description r6=howTo
      CRED)  [ "$r4" = 1 ] && printf '%s\037%s\037%s\037%s\037%s\037%s\n' "$p" "$r2" "$r5" "$r3" "" "$r6" >> "$CRED_PLAN" || true ;;
      # README §2.7: one-liners that prove the provider works, with this install's own base URL
      # and credential variable already substituted in. They are recorded rather than run: an
      # endpoint that is down is a runtime condition, not an install failure. They go into
      # provider-notes.md so the operator has the exact command instead of having to derive it.
      VERIFY)
        printf -- '\n**Verify — %s**\n\n    %s\n' "$r1" "$r2" >> "$NOTES_LOG"
        VERIFY_ANY=1 ;;
    esac
  done < "$RES"
  ok "$p: $(awk -F"$US" '$1=="MODEL"' "$RES" | wc -l | tr -d ' ') model(s) available"
done
if [ "${NOTES_SHOWN:-0}" = 1 ]; then
  info "each · above is the headline of a longer note; the full text is saved to $AGENT_DIR/provider-notes.md"
fi
if [ "$VERIFY_ANY" = 1 ]; then
  # The install cannot run these for you: they need the credential, which is collected later, and a
  # reachable endpoint. Naming them here is the difference between a step you were told about and
  # one you discover when the first turn fails.
  todo_add "     run the per-provider verification one-liners once — each is written out in full in $AGENT_DIR/provider-notes.md"
fi

# --- non-secret environment variables a provider needs exported. They are NOT secrets, but they
# belong in the same env file, because that is the one place both an interactive shell and a
# headless run read. Writing them into config/shell/pi-env.sh instead would dirty a tracked file
# and make the next `git pull` conflict on every machine.
if [ -s "$ENV_PLAN" ] && ask_section providers; then
  while IFS=$'\037' read -r e_prov e_name e_suggest e_required e_desc; do
    [ -n "$e_name" ] || continue
    if eval "[ -n \"\${$e_name:-}\" ]"; then ok "\$$e_name is already exported — left alone"; continue; fi
    if [ -f "$SECRETS_FILE" ] && grep -q "^$e_name=" "$SECRETS_FILE" 2>/dev/null; then
      ok "\$$e_name is already in $(basename "$SECRETS_FILE") — left alone"; continue
    fi
    ask "env.$e_name" "$e_name" "$e_suggest" string "$e_required" "" \
      "$e_desc${e_suggest:+  (suggested from the endpoint you just configured — change it if that is wrong)}" >/dev/null
  done < "$ENV_PLAN"
fi

# --- how each credential will be supplied. The VALUE is asked for later, during the apply
# phase, so that Ctrl-C at any point in the interview leaves no secret anywhere.
CRED_ACTIONS="$SCRATCH/credactions.tsv"; : > "$CRED_ACTIONS"

# cred_offer <section> <owner> <ENV_NAME> <what it is> <required 0|1> <keychain service|""> <how to get one>
#
# Appends one row to $CRED_ACTIONS: owner US env US mode US keychain-service, where mode is
# keep|secretsfile|keychain|later. Nothing here reads or stores a value — the apply phase does
# that, which is why a Ctrl-C anywhere in the interview can leave no secret behind.
#
# A function rather than inline code because there are two callers with the same policy: the
# provider loop below, and the MCP step in section 8. One credential policy, asked the same way,
# reported the same way on the review screen.
cred_offer() {
  local sect="$1" owner="$2" env="$3" label="$4" required="$5" kc="$6" how="$7"
  local have=0 cm="" svc=""
  if [ -f "$SECRETS_FILE" ] && grep -q "$env" "$SECRETS_FILE" 2>/dev/null; then have=1; fi
  if eval "[ -n \"\${$env:-}\" ]"; then have=1; fi
  if [ "$have" = 1 ]; then
    ok "$env is already available — left alone"
    printf '%s\037%s\037%s\037%s\n' "$owner" "$env" "keep" "" >> "$CRED_ACTIONS"
    return 0
  fi
  if ! ask_section "$sect" || [ "$INTERACTIVE" = 0 ]; then
    printf '%s\037%s\037%s\037%s\n' "$owner" "$env" "later" "" >> "$CRED_ACTIONS"
    warn "$env is not set — it will be listed as a manual step at the end"
    return 0
  fi
  printf '\n   %s%s%s needs %s%s%s%s\n' "$C_B" "$owner" "$C_0" "$C_B" "$env" "$C_0" \
    "$( [ "$required" = 1 ] && printf ' (required)' || printf ' (optional)' )"
  [ -z "$label" ] || info "$label"
  [ -z "$how" ] || info "how to get one: $how"
  printf '     1) type it during the install — stored in %s, chmod 0600\n' "$SECRETS_FILE"
  [ "$IS_MACOS" = 1 ] && printf '     2) macOS Keychain — read once per shell start, not once per request\n'
  printf '     3) later — PI still starts, and tells you what is unavailable and why\n'
  while :; do
    printf '   choice [1]: '; _read_tty cm; [ -n "$cm" ] || cm=1
    case "$cm" in
      1) printf '%s\037%s\037%s\037%s\n' "$owner" "$env" "secretsfile" "" >> "$CRED_ACTIONS"; return 0 ;;
      2) if [ "$IS_MACOS" != 1 ]; then printf '   %sthe Keychain is macOS-only%s\n' "$C_ER" "$C_0"; continue; fi
         svc="${kc:-pi-$(printf '%s' "$env" | tr 'A-Z_' 'a-z-')}"
         printf '%s\037%s\037%s\037%s\n' "$owner" "$env" "keychain" "$svc" >> "$CRED_ACTIONS"; return 0 ;;
      3) printf '%s\037%s\037%s\037%s\n' "$owner" "$env" "later" "" >> "$CRED_ACTIONS"; return 0 ;;
      *) printf '   %s1, 2 or 3%s\n' "$C_ER" "$C_0" ;;
    esac
  done
}

if [ -s "$CRED_PLAN" ]; then
  printf '\n   %s--- credentials ---%s\n' "$C_B" "$C_0"
  info "Secrets are never written into this repository. They go to $SECRETS_FILE (chmod 0600)"
  info "or into the macOS Keychain; the config files only ever reference \$VARIABLE names."
  while IFS=$'\037' read -r c_provider c_env c_label c_required c_keychain c_how; do
    [ -n "$c_env" ] || continue
    cred_offer providers "$c_provider" "$c_env" "$c_label" "$c_required" "$c_keychain" "$c_how"
  done < "$CRED_PLAN"
fi

# =========================================================================== SECTION 4: tiers ===
section "Tier bindings" \
  "Your agents and skills ask for a tier (strong, light, confidential), never for a model id. This is where a tier gets pointed at a real model."

ROUTING_DEFAULT=""
for cand in "$REPO_DIR/config/routing.default.json" "$REPO_DIR/config/routing.json"; do
  [ -f "$cand" ] && { ROUTING_DEFAULT="$cand"; break; }
done
MODELS_DEFAULT=""
[ -f "$REPO_DIR/config/models.default.json" ] && MODELS_DEFAULT="$REPO_DIR/config/models.default.json"

TIER_LIST="$SCRATCH/tiers.tsv"; : > "$TIER_LIST"
[ -z "$ROUTING_DEFAULT" ] || providers_tool tiers "$ROUTING_DEFAULT" > "$TIER_LIST" 2>/dev/null || : > "$TIER_LIST"

# A fragment may offer a tier the shipped routing table does not BIND — `confidential` from an
# endpoint inside your own boundary is the shipped case, since routing.default.json leaves that one
# in `tiersUnbound`. Those are precisely the tiers a user GAINS by selecting that provider, so they
# join the interview instead of being dropped silently. They are marked optional: nothing in the
# repo breaks if they stay unbound.
if [ -s "$TIER_SUGGESTIONS" ]; then
  while IFS=$'\037' read -r s_tier s_model; do
    [ -n "$s_tier" ] || continue
    grep -q "^$s_tier$(printf '\037')" "$TIER_LIST" && continue
    case "$s_tier" in
      confidential) _purpose="work that must not leave a boundary you control" ;;
      *)            _purpose="offered by a provider you selected" ;;
    esac
    printf '%s\037%s\037%s\037%s\037%s\n' "$s_tier" 1 "$_purpose" "$s_model" "" >> "$TIER_LIST"
  done < "$TIER_SUGGESTIONS"
fi

TIER_PROPOSAL="$SCRATCH/tierprop.tsv"; : > "$TIER_PROPOSAL"
if [ -s "$TIER_LIST" ]; then
  # shellcheck disable=SC2034  # t_thinking names the 5th field so `read` does not glue it onto
  # t_model; the value itself is not needed here. Naming it is what keeps the split correct.
  while IFS=$'\037' read -r t_name t_optional t_purpose t_model t_thinking; do
    [ -n "$t_name" ] || continue
    if ans_has "tier.$t_name" && [ "$RECONFIGURE" = 0 ]; then _proposed="$(ans_get "tier.$t_name")"
    else
      _proposed="$(awk -F"$US" -v t="$t_name" '$1==t {print $2; exit}' "$TIER_SUGGESTIONS")"
      if [ -z "$_proposed" ] && [ -n "$t_model" ]; then
        case " $SELECTED " in *" ${t_model%%/*} "*) _proposed="$t_model" ;; esac
      fi
      # Nothing suggested this tier: fall back to the first model of the first chosen provider,
      # so a complete routing table is still offered rather than a half-bound one.
      [ -n "$_proposed" ] || _proposed="$(head -n1 "$MODEL_CHOICES" | cut -d"$US" -f1)"
      ans_has "tier.$t_name" && [ "$RECONFIGURE" = 0 ] || ans_set "tier.$t_name" "$_proposed"
    fi
    printf '%s\037%s\037%s\037%s\n' "$t_name" "$t_optional" "$_proposed" "$t_purpose" >> "$TIER_PROPOSAL"
  done < "$TIER_LIST"

  printf '\n'
  while IFS=$'\037' read -r t_name t_optional t_proposed t_purpose; do
    printf '     %-14s -> %-44s %s%s%s\n' "$t_name" "${t_proposed:-<unbound>}" "$C_D" "$t_purpose" "$C_0"
  done < "$TIER_PROPOSAL"

  _edit_tiers=0
  if ask_section tiers && [ "$INTERACTIVE" = 1 ] && [ "$EXPRESS" = 0 ]; then
    printf '\n'
    ask_yes_no "use these tier bindings?" y || _edit_tiers=1
  fi
  while IFS=$'\037' read -r t_name t_optional t_proposed t_purpose; do
    if [ "$_edit_tiers" = 1 ]; then
      printf '\n   %s%s%s — %s\n' "$C_B" "$t_name" "$C_0" "$t_purpose"
      _n=0
      while IFS=$'\037' read -r m_id m_name; do
        _n=$((_n + 1)); printf '     %2d) %-44s %s%s%s\n' "$_n" "$m_id" "$C_D" "$m_name" "$C_0"
      done < "$MODEL_CHOICES"
      [ "$t_optional" = 1 ] && printf '      0) leave unbound (this tier is optional)\n'
      while :; do
        printf '   number, or a full provider/model id [%s]: ' "${t_proposed:-0}"
        _pick=""; _read_tty _pick; [ -n "$_pick" ] || _pick="${t_proposed:-0}"
        case "$_pick" in
          0) if [ "$t_optional" = 1 ]; then ans_set "tier.$t_name" ""; break; fi
             printf '   %s"%s" is not optional; it needs a model%s\n' "$C_ER" "$t_name" "$C_0" ;;
          ''|*[!0-9]*)
             case "$_pick" in
               */*) ans_set "tier.$t_name" "$_pick"; break ;;
               *) printf '   %spick a number, or type provider/model-id%s\n' "$C_ER" "$C_0" ;;
             esac ;;
          *) _line="$(sed -n "${_pick}p" "$MODEL_CHOICES")"
             if [ -n "$_line" ]; then ans_set "tier.$t_name" "$(printf '%s' "$_line" | cut -d"$US" -f1)"; break; fi
             printf '   %sno such number%s\n' "$C_ER" "$C_0" ;;
        esac
      done
    else
      ans_set "tier.$t_name" "$t_proposed"
    fi
  done < "$TIER_PROPOSAL"
  ok "$(wc -l < "$TIER_PROPOSAL" | tr -d ' ') tier(s) bound"
  plan_add "generate config/routing.json (tier bindings + egress classes)"
else
  warn "no tier template found (config/routing.default.json) — routing.json comes from the fragments alone"
fi

# ======================================================================== SECTION 5: behaviour ===
section "Agent behaviour" \
  "Which model PI opens with, how hard it thinks by default, and how it looks. All of it is changeable later inside PI."

SETTINGS_FILE="$REPO_DIR/config/settings.json"
DEF_PROVIDER="$(printf '%s' "$SELECTED" | cut -d' ' -f1)"
_strong="$(ans_get tier.strong)"
[ -n "$_strong" ] || _strong="$(head -n1 "$MODEL_CHOICES" | cut -d"$US" -f1)"
DEF_PROVIDER_GUESS="${_strong%%/*}"
[ -z "$DEF_PROVIDER_GUESS" ] || DEF_PROVIDER="$DEF_PROVIDER_GUESS"
DEF_MODEL_GUESS="${_strong#*/}"

EDITOR_GUESS="vi"
command -v vim >/dev/null 2>&1 && EDITOR_GUESS="vim"
[ -z "${EDITOR:-}" ] || EDITOR_GUESS="$EDITOR"
command -v code >/dev/null 2>&1 && EDITOR_GUESS="code --wait"

if ask_section agent && [ "$EXPRESS" = 0 ]; then
  ask settings.defaultProvider "default provider" "$DEF_PROVIDER" enum 1 "$(printf '%s' "$SELECTED" | tr ' ' ',')" \
    "The provider a new session starts on. You can switch inside PI at any time." >/dev/null
  ask settings.defaultModel "default model id (no provider prefix)" "$DEF_MODEL_GUESS" string 1 "" \
    "The model that provider opens with. It must be one that provider actually serves." >/dev/null
  ask settings.defaultThinkingLevel "default thinking level" medium enum 1 "minimal,low,medium,high" \
    "How much reasoning budget every turn gets before you ask for more. medium is a good default." >/dev/null
  ask settings.theme "theme" "Tokyo Night" enum 1 "$(theme_choices)" \
    "Colour scheme of the terminal UI. Everything but dark and light ships in themes/; those two are PI's own." >/dev/null
  ask settings.externalEditor "external editor command" "$EDITOR_GUESS" string 1 "" \
    "Used when you press the edit key on a long prompt. It must block until the file is closed (hence --wait)." >/dev/null
  ask settings.tuiMode "TUI mode" regular enum 1 "regular,compact" \
    "compact fits more on screen; regular is easier to read." >/dev/null
else
  ans_has settings.defaultProvider || ans_set settings.defaultProvider "$DEF_PROVIDER"
  ans_has settings.defaultModel || ans_set settings.defaultModel "$DEF_MODEL_GUESS"
  ans_has settings.defaultThinkingLevel || ans_set settings.defaultThinkingLevel medium
  ans_has settings.theme || ans_set settings.theme "Tokyo Night"
  ans_has settings.externalEditor || ans_set settings.externalEditor "$EDITOR_GUESS"
  ans_has settings.tuiMode || ans_set settings.tuiMode regular
  ok "defaults kept: $(ans_get settings.defaultProvider)/$(ans_get settings.defaultModel), thinking=$(ans_get settings.defaultThinkingLevel), theme=$(ans_get settings.theme)"
fi
plan_add "update config/settings.json (default model, thinking, theme, editor)"

# =========================================================================== SECTION 6: safety ===
section "Safety posture" \
  "PI can run shell commands. A small, fixed set of catastrophic shapes — credential-file reads, rm -rf /, a disk-format command, a force-push onto a protected branch, and a handful of others — is refused outright, in code, and there is nothing to configure for that. Everything else runs unattended, with no prompt. This section only asks which branches count as protected."

GUARD_FILE="$REPO_DIR/config/guard.json"
TRUST_FILE="$REPO_DIR/config/trusted-roots.json"
PATHS_FILE="$REPO_DIR/config/path-defaults.json"

if ask_section safety && [ "$INTERACTIVE" = 1 ]; then
  printf '\n   %sThere is no allowlist and no per-command approval to configure: every program runs%s\n' "$C_D" "$C_0"
  printf '   %sheadless, with no prompt, unless the exact command shape it is used for is one of the%s\n' "$C_D" "$C_0"
  printf '   %shandful this refuses unconditionally. That refusal is not a setting — it cannot be%s\n' "$C_D" "$C_0"
  printf '   %swidened from here.%s\n\n' "$C_D" "$C_0"
fi

if ask_section safety && [ "$EXPRESS" = 0 ]; then
  ask guard.protectedBranches "branches PI must never push to or force-update" "main,master" string 1 "" \
    "A force-push onto one of these is refused outright, in every mode." >/dev/null
fi

# Project roots: derived from what actually exists on this machine, never inherited from whoever
# built the repo. These decide where PI trusts a checkout without asking, and which tier a
# session in that directory starts on.
_root_guess=""
for d in "$HOME/projects" "$HOME/Projects" "$HOME/src" "$HOME/work" "$HOME/dev" "$HOME/code" "$HOME/repos"; do
  [ -d "$d" ] || continue
  _root_guess="${_root_guess:+$_root_guess,}$(printf '%s' "$d" | sed "s|^$HOME|~|")"
done
# shellcheck disable=SC2088  # the literal ~ is deliberate: PI expands it, so the config stays portable
[ -n "$_root_guess" ] || _root_guess="~/projects"
if ask_section safety && [ "$EXPRESS" = 0 ]; then
  ask trust.roots "directories whose checkouts PI may trust without asking" "$_root_guess" string 1 "" \
    "Comma-separated. Anywhere outside these, PI asks before it will execute a repository's own code." >/dev/null
else
  ans_has trust.roots || ans_set trust.roots "$_root_guess"
fi
ok "trusted roots: $(ans_get trust.roots)"
plan_add "update config/guard.json, config/trusted-roots.json, config/path-defaults.json"

# ============================================================ SECTION 7: tools and integrations ===
section "Tools and integrations" \
  "Web search, language servers and quota metering. Every one of them is optional; each is off or defaulted if you say no."

WEB_FILE="$REPO_DIR/config/web.json"
WEBSEARCH_FILE="$REPO_DIR/config/web-search.json"
LSP_FILE="$REPO_DIR/config/pi-lsp.json"
QUOTA_FILE="$REPO_DIR/config/quota.json"

if ask_section tools && [ "$EXPRESS" = 0 ]; then
  ask web.backend "web search backend" none enum 1 "searxng,tavily,brave,exa,none" \
    "Exactly one backend, pinned in config — pi-web-access's multi-provider auto-detection stays off whichever you pick.
   searxng — an instance you host yourself: no key, no third party, but the service is yours to run.
   tavily, brave, exa — a hosted search API. Each has a free tier you can sign up for without a card; the key is asked for in the credentials step and stored in $SECRETS_FILE, never in a config file.
   none — the web_search tool is not registered at all, rather than left to fail at the first call. web_fetch still works and still needs no key: page extraction falls back to Jina Reader (r.jina.ai), which is what reads the JavaScript-heavy pages." >/dev/null
  case "$(ans_get web.backend)" in
    searxng)
      ask web.searxngBaseUrl "SearXNG base URL" "http://127.0.0.1:8080" url 1 "" \
        "The address of your own SearXNG. It must answer /search?format=json." >/dev/null ;;
  esac
  ask web.proxy "HTTPS proxy for outbound requests (blank if none)" "${HTTPS_PROXY:-}" string 0 "" \
    "Only if your network forces one. It is exported from your shell rc, not stored in any config file." >/dev/null
else
  ans_has web.backend || ans_set web.backend none
fi
ok "web search: $(ans_get web.backend)"

# A hosted backend needs one API key, and pi-web-access reads it from the environment on its own
# (TAVILY_API_KEY / BRAVE_API_KEY / EXA_API_KEY) — so it goes through cred_offer like every other
# secret and never near a tracked config file. Outside the interview branch above on purpose:
# --express, --yes and --answers can all pin a hosted backend too, and each of them still owes the
# key an account of where it will come from.
case "$(ans_get web.backend)" in
  tavily) cred_offer tools "web search (tavily)" TAVILY_API_KEY \
    "The key web_search authenticates with. pi-web-access reads it from the environment; it is never written into config/web-search.json." \
    1 "" "https://app.tavily.com — sign up and copy the API key (free tier, no card)" ;;
  brave) cred_offer tools "web search (brave)" BRAVE_API_KEY \
    "The key web_search authenticates with. pi-web-access reads it from the environment; it is never written into config/web-search.json." \
    1 "" "https://brave.com/search/api/ — subscribe to the free plan and copy the key" ;;
  exa) cred_offer tools "web search (exa)" EXA_API_KEY \
    "The key web_search authenticates with. pi-web-access reads it from the environment; it is never written into config/web-search.json." \
    1 "" "https://dashboard.exa.ai — sign up and create an API key (signup credit, no card)" ;;
esac

# Language servers. Detected, never assumed: PI's LSP integration silently does nothing when the
# server binary is missing, which is the most confusing possible failure mode.
LSP_PRESENT=""; LSP_MISSING=""
if [ -f "$LSP_FILE" ]; then
  for _srv in $(node "$LIB_JSON" keys "$LSP_FILE" servers 2>/dev/null || true); do
    _cmd="$(node "$LIB_JSON" get "$LSP_FILE" "servers.$_srv.command" 2>/dev/null | head -n1)"
    if [ -n "$_cmd" ] && command -v "$_cmd" >/dev/null 2>&1; then LSP_PRESENT="$LSP_PRESENT $_srv"
    else LSP_MISSING="$LSP_MISSING $_srv:${_cmd:-?}"; fi
  done
fi
[ -z "$LSP_PRESENT" ] || ok "language servers found:$LSP_PRESENT"
if [ -n "$LSP_MISSING" ]; then
  warn "no language server on PATH for:$LSP_MISSING"
  info "PI still edits those files; it just has no types, no go-to-definition and no diagnostics."
  if ask_section tools && [ "$INTERACTIVE" = 1 ] && [ "$EXPRESS" = 0 ] && command -v npm >/dev/null 2>&1; then
    if ask_yes_no "install the missing npm-based language servers globally now?" n; then
      ans_set lsp.install 1
    else
      ans_set lsp.install 0
      todo_add "     install the language servers you want:$LSP_MISSING (each has its own installer)"
    fi
  else
    todo_add "     install the language servers you want:$LSP_MISSING — PI works without them, with no diagnostics"
  fi
fi

if [ -f "$(cfg_seed quota)" ]; then
  if ask_section tools && [ "$EXPRESS" = 0 ]; then
    ask quota.enabled "show a provider quota meter in the status line?" false enum 1 "true,false" \
      "Only some providers publish a usage API. If yours does not, the meter renders as a dash and costs nothing." >/dev/null
  else
    ans_has quota.enabled || ans_set quota.enabled false
  fi
fi

# Skills. This repository ships the loading mechanism and no skills at all, on purpose — a skill
# is prose plus scripts, and prose is exactly where somebody's employer leaks out. So the only
# thing to decide here is where YOUR skills will live, and the answer is a git-ignored directory
# so that writing one can never turn into committing one.
SKILLS_DIR="$REPO_DIR/skills"
if [ -d "$SKILLS_DIR" ]; then
  ok "your skills directory already exists: $SKILLS_DIR"
  ans_set skills.dir 1
elif ask_section tools && [ "$EXPRESS" = 0 ]; then
  info "This repo ships zero skills — only the machinery that loads them."
  info "$SKILLS_DIR is git-ignored and is already a skill search path in settings.json."
  if ask_yes_no "create it now, as the place for your own skills?" y; then ans_set skills.dir 1
  else ans_set skills.dir 0; fi
else
  ans_has skills.dir || ans_set skills.dir 1
fi

if ask_section tools && [ "$INTERACTIVE" = 1 ] && [ "$EXPRESS" = 0 ]; then
  printf '\n   %sThe remaining files ship with defaults that are good for most people:%s\n' "$C_D" "$C_0"
  printf '   %scompaction.json digest.json bash-timeouts.json dispatch.json hooks.yaml%s\n' "$C_D" "$C_0"
  printf '   %skeybindings.json pi-statusline.json tasks.json%s\n' "$C_D" "$C_0"
  if ! ask_yes_no "keep those defaults?" y; then
    todo_add "     review and edit by hand: config/{compaction,digest,bash-timeouts,dispatch,tasks}.json, config/hooks.yaml"
    info "left as shipped for now — they are plain JSON and safe to edit at any time"
  fi
fi

# ============================================================================== SECTION 8: MCP ===
section "MCP servers" \
  "An MCP server is third-party code reached with your credentials, so this harness declares none by default."

MCP_FILE="$REPO_DIR/config/mcp.json"
MCP_PICKED=""

# An mcp.json that already exists is the user's own file, possibly hand-written from
# config/mcp.example.json. Editing it here would silently overwrite that work, so the whole step
# stands down and says so.
if [ -f "$MCP_FILE" ]; then
  ok "config/mcp.json already exists — left alone (it is yours to edit)"
  info "add or remove servers there by hand; config/mcp.example.json is the annotated template."
elif [ ! -f "$REPO_DIR/config/mcp.example.json" ]; then
  info "config/mcp.example.json is not in this checkout — nothing to offer."
else
  info "PI reads MCP servers from config/mcp.json and nowhere else: hostConfigDiscovery is \"off\","
  info "so servers another agent configured on this machine are never picked up silently."
  if ask_section tools && [ "$EXPRESS" = 0 ] && [ "$INTERACTIVE" = 1 ]; then
    info "The default here is none. These two are public services, offered because they are"
    info "self-explanatory — not because you need them:"
    printf '\n     1) %scontext7%s    up-to-date library documentation, over HTTP\n' "$C_B" "$C_0"
    printf '                    needs a CONTEXT7_API_KEY\n'
    printf '     2) %splaywright%s  drives a real browser, over stdio\n' "$C_B" "$C_0"
    printf '                    started through %smcp-stdio-guard%s: the child process gets an EMPTY\n' "$C_B" "$C_0"
    printf '                    environment plus one allowlisted variable (PLAYWRIGHT_BROWSERS_PATH),\n'
    printf '                    instead of inheriting every API key you have exported\n'
    ask mcp.servers "numbers, comma-separated, or blank for none" "" string 0 "" \
      "Whatever you pick is written to config/mcp.json, which is git-ignored. You can re-run this step later with --section tools." >/dev/null
  else
    ans_has mcp.servers || ans_set mcp.servers ""
  fi
  for _n in $(printf '%s' "$(ans_get mcp.servers)" | tr ',' ' '); do
    case "$_n" in
      1|context7)   MCP_PICKED="$MCP_PICKED context7" ;;
      2|playwright) MCP_PICKED="$MCP_PICKED playwright" ;;
      *) warn "ignoring '$_n' — only 1 (context7) and 2 (playwright) are offered here" ;;
    esac
  done
  MCP_PICKED="$(printf '%s' "$MCP_PICKED" | sed 's/^ //')"
  if [ -z "$MCP_PICKED" ]; then
    ok "no MCP servers — config/mcp.json will be written with an empty server list"
    todo_add "     (optional) add MCP servers later: copy an entry from config/mcp.example.json into config/mcp.json"
  else
    ok "MCP servers: $MCP_PICKED"
    plan_add "write config/mcp.json with: $MCP_PICKED"
    case " $MCP_PICKED " in
      *" context7 "*)
        cred_offer tools "context7 (MCP)" CONTEXT7_API_KEY \
          "The key context7 authenticates with. It is referenced from mcp.json as \${CONTEXT7_API_KEY}, never inlined." \
          1 "" "https://context7.com — sign in and create one" ;;
    esac
    case " $MCP_PICKED " in
      *" playwright "*)
        info "playwright downloads its browsers on first use, into ~/.cache/ms-playwright."
        todo_add "     (optional) pre-download the playwright browsers:  npx -y playwright install chromium" ;;
    esac
  fi
fi

# ============================================================================ SECTION 9: shell ===
section "Shell integration" \
  "The most common reason an install 'does not work': the config is perfect and the shell never loads it."

USER_SHELL="$(basename "${SHELL:-/bin/sh}")"
RC_CANDIDATES=""
case "$USER_SHELL" in
  zsh)  RC_CANDIDATES="$PREFIX/.zshrc" ;;
  bash) RC_CANDIDATES="$PREFIX/.bashrc"
        [ -f "$PREFIX/.bash_profile" ] && RC_CANDIDATES="$RC_CANDIDATES $PREFIX/.bash_profile" ;;
  *)    RC_CANDIDATES="$PREFIX/.profile" ;;
esac
# Whatever the login shell is, update every rc file that already exists — a machine with both
# .zshrc and .bashrc is normal, and half-configured shells are how "it works in one terminal but
# not the other" happens.
for rc in "$PREFIX/.zshrc" "$PREFIX/.bashrc" "$PREFIX/.profile"; do
  [ -f "$rc" ] || continue
  case " $RC_CANDIDATES " in *" $rc "*) : ;; *) RC_CANDIDATES="$RC_CANDIDATES $rc" ;; esac
done
ok "login shell: $USER_SHELL"

if [ "$PREFIX" = "$HOME" ]; then RC_BIN='$HOME/bin'; RC_ENV='$HOME/pi-config/config/shell/pi-env.sh'; RC_SEC='$HOME/.pi/secrets.env'
else RC_BIN="$BIN_DIR"; RC_ENV="$STABLE_LINK/config/shell/pi-env.sh"; RC_SEC="$SECRETS_FILE"; fi

if [ "$DO_SHELL" = 1 ] && ask_section shell && [ "$INTERACTIVE" = 1 ]; then
  printf '\n   %sThese exact lines would be appended (once, between markers so they can be removed cleanly):%s\n\n' "$C_D" "$C_0"
  printf '     %s\n' "$MARKER"
  printf '     export PATH="%s:$PATH"\n' "$RC_BIN"
  printf '     [ -f "%s" ] && . "%s"\n' "$RC_ENV" "$RC_ENV"
  [ -z "$(ans_get web.proxy)" ] || {
    printf '     export HTTPS_PROXY="%s"; export HTTP_PROXY="$HTTPS_PROXY"\n' "$(ans_get web.proxy)"
    printf '     export NO_PROXY="127.0.0.1,localhost,::1,.local"\n'; }
  printf '     %s\n\n' "$MARKER_END"
  info "pi-env.sh sets the runtime posture (telemetry off, no version ping) and sources your secrets file."
  ask_yes_no "append that to: $RC_CANDIDATES ?" y || DO_SHELL=0
fi
if [ "$DO_SHELL" = 1 ]; then
  plan_add "append the pi-config block to:$(printf '%s' " $RC_CANDIDATES")"
  plan_add "append a headless block to $PREFIX/.zshenv (so cron and launchd runs get credentials too)"
else
  todo_add "     add this to your shell rc yourself:  . $RC_ENV"
fi

# ==================================================================== SECTION 10: maintenance ===
section "Staying up to date" \
  "PiON updates by fast-forwarding this clone. A cron entry can watch origin/main every half hour and leave a note; whether to APPLY what it found stays a decision you make in a session, with the commit list on screen."

AUTOUPDATE_FILE="$REPO_DIR/config/auto-update.json"
AUTOUPDATE_SCRIPT="$REPO_DIR/scripts/auto-update-check.sh"
# The whole cron contract in one string. Every operation on the crontab — add, replace, remove,
# and uninstall.sh's own removal — matches on THIS marker and nothing else, so a line a user wrote
# by hand that happens to call the same script is never touched by us.
CRON_MARK="# pi-config:auto-update"
# Read from the live config when there is one, the template otherwise. The key is therefore
# load-bearing rather than decorative: edit config/auto-update.json, re-run --section maintenance
# (or --repair), and the entry is rewritten at the new cadence.
AUTOUPDATE_INTERVAL="$(json get "$(cfg_seed auto-update)" autoUpdate.intervalMinutes 2>/dev/null || printf '30')"
case "$AUTOUPDATE_INTERVAL" in ''|*[!0-9]*) AUTOUPDATE_INTERVAL=30 ;; esac
[ "$AUTOUPDATE_INTERVAL" -ge 1 ] 2>/dev/null && [ "$AUTOUPDATE_INTERVAL" -le 59 ] || AUTOUPDATE_INTERVAL=30
CRON_LINE="*/$AUTOUPDATE_INTERVAL * * * * $AUTOUPDATE_SCRIPT >/dev/null 2>&1 $CRON_MARK"

# ask() returns a stored answer WITHOUT asking, which is right for --yes and --answers and wrong
# for the one run where the user explicitly asked to be interviewed again. --reconfigure and
# --section both set RECONFIGURE=1: drop the stored value, re-offer it as the default. The
# question gets asked; Enter still keeps the previous answer.
if [ "$RECONFIGURE" = 1 ] && [ "$INTERACTIVE" = 1 ] && ask_section maintenance; then
  for _k in autoupdate.enabled autoupdate.mode; do
    if ans_has "$_k"; then eval "_prev_${_k##*.}=\$(ans_get "$_k")"; ans_unset "$_k"; fi
  done
fi
_au_enabled_def="${_prev_enabled:-false}"
_au_mode_def="${_prev_mode:-prompt}"

if ask_section maintenance && [ "$EXPRESS" = 0 ]; then
  AUTOUPDATE_ENABLED="$(ask autoupdate.enabled "check origin/main for updates every $AUTOUPDATE_INTERVAL minutes" \
    "$_au_enabled_def" enum 1 "true,false" \
    "A user-level cron entry running scripts/auto-update-check.sh. It fetches and counts; it never merges, never checks out, and never touches your working tree. Off by default: a background job that talks to a network every half hour is yours to opt into, not ours to assume.")"
  if [ "$AUTOUPDATE_ENABLED" = true ]; then
    ask autoupdate.mode "when an update is waiting, prompt or auto" "$_au_mode_def" enum 1 "prompt,auto" \
      "prompt: the next session tells you, and you run ./scripts/update.sh when it suits you. auto: that session starts ./scripts/update.sh --yes in the background for you. Read the warning in docs/extensions/auto-update.md before choosing auto — it rewrites the tree the running session is reading from." >/dev/null
  fi
else
  ans_has autoupdate.enabled || ans_set autoupdate.enabled "$_au_enabled_def"
  ans_has autoupdate.mode    || ans_set autoupdate.mode "$_au_mode_def"
  AUTOUPDATE_ENABLED="$(ans_get autoupdate.enabled)"
fi
[ "$AUTOUPDATE_ENABLED" = true ] || AUTOUPDATE_ENABLED=false
# The mode question is only reached when the first answer was yes, so on every other path it has
# no stored value at all — and `autoUpdate.mode: ""` is a state the config schema, the check
# script and the extension all have no reading for. Record the default instead: turning
# auto-update on later, or replaying this answers file, then starts from a real value.
ans_has autoupdate.mode || ans_set autoupdate.mode "$_au_mode_def"

if [ "$AUTOUPDATE_ENABLED" = true ]; then
  plan_add "write config/auto-update.json (enabled, mode=$(ans_get autoupdate.mode))"
  plan_add "add one user-level cron entry: $CRON_LINE"
else
  plan_add "write config/auto-update.json (auto-update off) and remove any cron entry we added before"
fi

# =================================================================== review, then apply =========
step "Review — nothing has been written yet"

printf '\n%s  This is everything the install will do:%s\n' "$C_B" "$C_0"
printf '\n   providers      %s\n' "$SELECTED"
printf '   pi runtime     %s\n' "$( [ "$SKIP_RUNTIME" = 1 ] && printf 'untouched (--skip-runtime)' || printf '%s, version %s -> %s/pi' "$MODE" "$PI_VERSION_EXPECTED" "$BIN_DIR" )"
printf '   generated      in %s/config/ — every one of these is git-ignored:\n' "$REPO_DIR"
printf '                  models.json, routing.json, mcp.json,\n'
printf '                  %s\n' "$(printf '%s' "$GENERATED_CONFIGS" | sed 's/ /.json, /g;s/$/.json/')"
printf '                  %sthe tracked config/*.default.json templates are read, never written%s\n' "$C_D" "$C_0"
printf '   mcp servers    %s\n' "$( [ -f "$MCP_FILE" ] && printf 'config/mcp.json exists — untouched' || printf '%s' "${MCP_PICKED:-none (opt in later from config/mcp.example.json)}" )"
printf '   packages       %s\n' \
  "$( [ "$SKIP_PACKAGES" = 1 ] && printf 'untouched (--skip-packages)' \
      || { [ -d "$REPO_DIR/node_modules" ] && printf 'already installed' || printf 'npm install --ignore-scripts (the packaged extensions)'; } )"
printf '   symlinked into %s\n' "$AGENT_DIR"
printf '   helpers onto   %s\n' "$BIN_DIR"
printf '   secrets file   %s (0600)\n' "$SECRETS_FILE"
printf '   shell rc       %s\n' "$( [ "$DO_SHELL" = 1 ] && printf '%s' "$RC_CANDIDATES" || printf 'untouched' )"
printf '   auto-update    %s\n' "$( [ "$AUTOUPDATE_ENABLED" = true ] \
  && printf 'cron every %s min, %s on the next session' "$AUTOUPDATE_INTERVAL" "$(ans_get autoupdate.mode)" \
  || printf 'off — no cron entry, no background fetch' )"
printf '   manifest       %s  (what uninstall.sh reads back)\n' "$MANIFEST"
if [ -s "$CRED_ACTIONS" ]; then
  printf '\n   credentials:\n'
  while IFS=$'\037' read -r a_prov a_env a_mode a_svc; do
    case "$a_mode" in
      keep)        printf '     %-28s already available\n' "$a_env" ;;
      secretsfile) printf '     %-28s you will be asked for the value, stored in secrets.env\n' "$a_env" ;;
      keychain)    printf '     %-28s stored in the macOS Keychain as "%s"\n' "$a_env" "$a_svc" ;;
      later)       printf '     %-28s deferred — listed as a manual step at the end\n' "$a_env" ;;
    esac
  done < "$CRED_ACTIONS"
fi
[ -z "$PLAN" ] || printf '\n   details:%s\n' "$PLAN"
printf '\n   %sAnything replaced is backed up first, and the backup path is printed.%s\n' "$C_D" "$C_0"

if [ "$INTERACTIVE" = 1 ]; then
  printf '\n'
  ask_yes_no "go ahead?" y || { printf '\nnothing was changed. Re-run when you are ready.\n'; exit 0; }
fi

APPLYING=1
run "mkdir -p '$BIN_DIR' '$AGENT_DIR' '$CACHE_DIR' '$PI_HOME'"
# Recorded deepest-first-friendly: uninstall.sh sorts by path length and rmdirs each one only if
# it is empty, so ~/.pi/agent is tried before ~/.pi and neither is removed while it still holds
# anything. $PI_HOME is on the list because `mkdir -p` above is what brought it into existence on
# a machine that never ran PI before; leaving an empty ~/.pi behind is a small but real orphan.
manifest_add DIR "$AGENT_DIR"
manifest_add DIR "$BIN_DIR"
manifest_add DIR "$PI_HOME"
# $CACHE_DIR itself is removed by uninstall.sh's own cache question. Its parent, ~/.cache, is
# listed here only so the empty-dir sweep can reclaim it when this install is what created it —
# the sweep never removes a non-empty directory, so a ~/.cache shared with other tools survives.
manifest_add DIR "$(dirname "$CACHE_DIR")"

# ------------------------------------------------------------- apply: stable path + runtime ---
step "Installing"

current_target="$(readlink "$STABLE_LINK" 2>/dev/null || true)"
if [ "$current_target" = "$REPO_DIR" ]; then ok "$STABLE_LINK -> $REPO_DIR"
elif [ -e "$STABLE_LINK" ] && [ -z "$current_target" ]; then
  die "PI-INSTALL-E12" "$STABLE_LINK exists and is a real directory, not a symlink" \
      "move it aside (mv '$STABLE_LINK' '$STABLE_LINK.bak') and re-run; every config path is addressed through it"
else
  run "ln -sfn '$REPO_DIR' '$STABLE_LINK'"
  changed "$STABLE_LINK -> $REPO_DIR (so the live config is this checkout: a git pull updates it)"
fi
manifest_add LINK "$STABLE_LINK" "$REPO_DIR"

# A real *directory* at $BIN_DIR/pi is a shape no mode can write through, and it fails silently:
# `ln -sfn TARGET $BIN_DIR/pi` does not replace a real directory, it creates the link INSIDE it
# (as $BIN_DIR/pi/pi) and exits 0. The run then continues to the version check, executes the
# directory, reads back nothing, and dies PI-INSTALL-E06 — "an older pi is earlier on PATH", which
# is not what happened. Extracting a release tree straight into $BIN_DIR produces exactly this
# state, so it is worth naming. `-L` first: a symlink pointing at a directory is fine, and `-d`
# alone would follow it.
if [ "$SKIP_RUNTIME" = 0 ] && [ ! -L "$BIN_DIR/pi" ] && [ -d "$BIN_DIR/pi" ]; then
  die "PI-INSTALL-E13" "$BIN_DIR/pi is a directory, not the pi executable" \
      "an unpacked release tree is sitting where the binary belongs; remove it and re-run: rm -rf '$BIN_DIR/pi'"
fi

if [ "$SKIP_RUNTIME" = 1 ]; then
  ok "pi runtime untouched (--skip-runtime)"
  SKIPPED="$SKIPPED
     the PI runtime install (--skip-runtime)"
elif [ "$INSTALLED_PI_VERSION" = "$PI_VERSION_EXPECTED" ]; then
  if [ -L "$BIN_DIR/pi" ]; then ok "pi $PI_VERSION_EXPECTED already installed (symlink -> $(readlink "$BIN_DIR/pi"))"
  else ok "pi $PI_VERSION_EXPECTED already installed at $BIN_DIR/pi"; fi
elif [ "$MODE" = "binary" ]; then
  [ "$PLATFORM" != "unsupported" ] || \
    die "PI-INSTALL-E03" "no standalone pi binary is published for $(uname -s) $(uname -m)" "re-run with --mode npm"
  [ -z "$INSTALLED_PI_VERSION" ] || warn "replacing pi $INSTALLED_PI_VERSION with the pinned $PI_VERSION_EXPECTED"
  asset="pi-${PLATFORM}.tar.gz"
  want_sha="$(json get "$LOCK" "binaries.${PLATFORM}.sha256" || true)"
  if [ "$OFFLINE" = 1 ]; then
    src="$OFFLINE_DIR/$asset"
    [ -f "$src" ] || die "PI-INSTALL-E15" "offline install needs '$src' and it is not there" \
         "stage the release archive for $PLATFORM in --offline-dir"
  else
    command -v curl >/dev/null 2>&1 || \
      die "PI-INSTALL-E10" "'curl' is not on PATH and this is an online install" \
          "install curl, or pre-stage the archives and re-run with --offline --offline-dir DIR"
    base="$(json get "$LOCK" releaseBase)"
    src="$CACHE_DIR/$asset"
    info "downloading ${base}/${asset}"
    run "curl -fsSL -o '$src' '${base}/${asset}'" \
      || die "PI-INSTALL-E16" "could not download ${base}/${asset}" \
             "check HTTPS_PROXY and NODE_EXTRA_CA_CERTS, or pre-stage the archive and use --offline-dir"
  fi
  if [ -z "$want_sha" ]; then
    warn "config/pi-release.lock carries no sha256 for $PLATFORM — integrity was NOT checked"
  elif [ "$DRY_RUN" = 1 ] && [ ! -f "$src" ]; then
    # --dry-run printed the download instead of performing it, so there is no artifact to hash.
    # Hashing anyway would abort inside the hasher with no PI-INSTALL code and no cause.
    warn "dry-run: '$src' was not fetched — sha256 NOT checked (a real run always verifies it)"
  else
    if command -v shasum >/dev/null 2>&1; then got="$(shasum -a 256 "$src" 2>/dev/null | cut -d' ' -f1 || true)"
    else got="$(sha256sum "$src" 2>/dev/null | cut -d' ' -f1 || true)"; fi
    [ -n "$got" ] || die "PI-INSTALL-E05" "cannot verify $asset — no sha256 could be computed for '$src'" \
         "the archive is missing or unreadable; re-stage it, or re-run without --offline"
    [ "$got" = "$want_sha" ] || die "PI-INSTALL-E05" "sha256 mismatch for $asset (got $got, want $want_sha)" \
         "do not use this archive — re-download, and if it mismatches again escalate it as a supply-chain event"
    ok "sha256 of $asset verified against config/pi-release.lock"
  fi
  # The release archive is a TREE, not a bare executable. It unpacks as a single `pi/` directory
  # holding the binary next to the native modules, wasm and bundled node_modules it loads at
  # runtime, so the binary cannot be lifted out of it — and extracting straight into $BIN_DIR
  # produced a *directory* at $BIN_DIR/pi, whose `--version` printed nothing and failed the check
  # below with a misleading "an older pi is earlier on PATH".
  #
  # So: unpack into a version-scoped tree and put a symlink on PATH. Version-scoped because two
  # installs of different versions must not interleave their files, and because it makes the
  # symlink's target the record of which version is live.
  #
  # The tree goes under a directory this installer owns outright, NOT under $PREFIX/.local/pi/ —
  # that is PI's own self-installer's address (`~/bin/pi -> ~/.local/pi/<version>/pi/pi`, what
  # `pi update` and the upstream curl installer write). Sharing it would mean unpacking over a
  # tree PI installed and, worse, recording it as ours: uninstall.sh removes a TREE row whole, so
  # `uninstall.sh` would delete a pi the user installed themselves. Our own namespace makes that
  # impossible by construction rather than by a check that can be got wrong.
  [ -n "$PI_VERSION_EXPECTED" ] || die "PI-INSTALL-E09" "config/pi-release.lock has no version" \
       "restore the lock file from git"
  runtime_root="$PREFIX/.local/share/pi-config/runtime"
  runtime_dir="$runtime_root/$PI_VERSION_EXPECTED"
  run "mkdir -p '$runtime_dir'"
  # No rm -rf first: the path is version-scoped, so a re-run overwrites its own identical files and
  # nothing else can be living here. tar overwrites in place.
  run "tar -xzf '$src' -C '$runtime_dir'"
  [ "$DRY_RUN" = 1 ] || [ -f "$runtime_dir/pi/pi" ] || \
    die "PI-INSTALL-E06" "$asset did not contain pi/pi — the archive layout changed" \
        "re-download the release, and if it is still wrong the pin in config/pi-release.lock needs review"
  run "chmod 0755 '$runtime_dir/pi/pi'"
  run "ln -sfn '$runtime_dir/pi/pi' '$BIN_DIR/pi'"
  changed "pi $PI_VERSION_EXPECTED -> $BIN_DIR/pi -> $runtime_dir/pi/pi"
  manifest_add TREE "$runtime_dir" "pi $PI_VERSION_EXPECTED runtime (binary mode)"
  # The parents `mkdir -p` created on the way down, so removing the version tree does not leave
  # them behind as empty orphans. DIR (rmdir-if-empty), never TREE: a second version installed
  # alongside this one must survive this one's removal, and .local/share is shared with every
  # other tool on the machine.
  manifest_add DIR "$runtime_root"
  manifest_add DIR "$(dirname "$runtime_root")"
  manifest_add DIR "$PREFIX/.local/share"
  manifest_add DIR "$PREFIX/.local"
  manifest_add LINK "$BIN_DIR/pi" "$runtime_dir/pi/pi"
else
  version_ge "$NODE_VERSION" "$NODE_MIN" || \
    die "PI-INSTALL-E04" "--mode npm needs node >= $NODE_MIN, found $NODE_VERSION" \
        "upgrade Node (mise, fnm and nvm all work user-space), or use --mode binary"
  spec="$(json get "$LOCK" npm.spec)"
  [ -n "$spec" ] || die "PI-INSTALL-E09" "config/pi-release.lock has no npm.spec" "restore the lock file from git"
  run "npm install -g --ignore-scripts '$spec'" \
    || die "PI-INSTALL-E17" "npm install of $spec failed" \
           "check 'npm config get registry' and HTTPS_PROXY; --ignore-scripts is mandatory, do not drop it"
  npm_prefix="$(npm config get prefix 2>/dev/null || echo "$PREFIX/.npm-global")"
  run "ln -sfn '$npm_prefix/bin/pi' '$BIN_DIR/pi'"
  changed "pi $PI_VERSION_EXPECTED via npm -> $BIN_DIR/pi"
  manifest_add LINK "$BIN_DIR/pi" "$npm_prefix/bin/pi"
  # Recorded separately from the LINK above: uninstall.sh removing $BIN_DIR/pi only unlinks our
  # shortcut to it. The package itself lives in npm's global tree, outside $PREFIX, and stays on
  # the machine — reachable from any shell with npm's global bin on PATH — until this row tells
  # uninstall.sh it is ours to remove too.
  manifest_add NPMGLOBAL "$(json get "$LOCK" npm.package)" "the pi $PI_VERSION_EXPECTED runtime itself (npm mode: npm install -g '$spec')"
fi

if [ "$DRY_RUN" = 0 ] && [ "$SKIP_RUNTIME" = 0 ]; then
  got_version="$(PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 "$BIN_DIR/pi" --version 2>/dev/null | tr -d 'v \n' || true)"
  [ "$got_version" = "$PI_VERSION_EXPECTED" ] || \
    die "PI-INSTALL-E06" "the installed pi reports '${got_version:-nothing}', expected '$PI_VERSION_EXPECTED'" \
        "an older pi is earlier on PATH, or the archive was wrong — check: command -v pi"
  ok "pi --version == $PI_VERSION_EXPECTED (checked with the network disabled)"
  printf '%s\n' "$MODE" > "$AGENT_DIR/.install-mode" 2>/dev/null || true
  manifest_add FILE "$AGENT_DIR/.install-mode" "install mode marker"
fi

have_fd=0; have_rg=0
{ command -v fd >/dev/null 2>&1 || command -v fdfind >/dev/null 2>&1; } && have_fd=1
command -v rg >/dev/null 2>&1 && have_rg=1
if [ "$have_fd" = 1 ] && [ "$have_rg" = 1 ]; then ok "fd and ripgrep present — pi will not auto-download them"
else
  warn "fd=$have_fd rg=$have_rg — pi would fetch the missing one from GitHub releases into $AGENT_DIR/bin"
  todo_add "     install fd and ripgrep with your package manager — optional, but file search is much faster with them"
fi

# ------------------------------------------------------------------ apply: generate configs ---
step "Writing the configuration"
info "config/*.default.json are the shipped templates. They are read, never written."
info "The generated config/*.json are git-ignored: they carry YOUR endpoints, not the repo's."

GEN_MODELS="$REPO_DIR/config/models.json"
GEN_ROUTING="$REPO_DIR/config/routing.json"
GEN_ARGS="--providers-dir $PROVIDERS_DIR --select $(printf '%s' "$SELECTED" | tr ' ' ',') --answers $ANSWERS"
[ -z "$MODELS_DEFAULT" ]  || GEN_ARGS="$GEN_ARGS --models-default $MODELS_DEFAULT"
[ -z "$ROUTING_DEFAULT" ] || GEN_ARGS="$GEN_ARGS --routing-default $ROUTING_DEFAULT"

if [ "$DRY_RUN" = 1 ]; then
  # shellcheck disable=SC2086
  if providers_tool generate $GEN_ARGS --print-only > "$SCRATCH/preview.json" 2>"$SCRATCH/gen.err"; then
    ok "generation rehearsed: $(wc -l < "$SCRATCH/preview.json" | tr -d ' ') lines of JSON would be written"
  else
    die "PI-INSTALL-E27" "config generation failed: $(tail -3 "$SCRATCH/gen.err" | tr '\n' ' ')" \
        "fix the reported tier or template problem and re-run"
  fi
else
  # Generate into the scratch directory first and only then decide. A re-run on a converged
  # machine must report "ok" and leave the file — and its timestamp — alone; writing an identical
  # file every time would also mean a backup copy per run, which is litter, not safety.
  # shellcheck disable=SC2086
  if ! providers_tool generate $GEN_ARGS --out-models "$SCRATCH/models.json" --out-routing "$SCRATCH/routing.json" \
       > "$SCRATCH/gen.out" 2>"$SCRATCH/gen.err"; then
    die "PI-INSTALL-E27" "config generation failed: $(tail -3 "$SCRATCH/gen.err" | tr '\n' ' ')" \
        "a tier pointing at a provider you did not install is the usual cause — re-run and bind it to one you did"
  fi
  for _pair in "models.json:$GEN_MODELS" "routing.json:$GEN_ROUTING"; do
    _new="$SCRATCH/${_pair%%:*}"; _dst="${_pair#*:}"
    if [ -f "$_dst" ] && cmp -s "$_new" "$_dst"; then
      ok "config/$(basename "$_dst") is already exactly what your answers produce"
    else
      backup_file "$_dst"
      mv "$_new" "$_dst"
      changed "wrote $_dst"
    fi
    manifest_add GENERATED "$_dst" "generated from templates + your answers"
  done
  while IFS=$'\037' read -r kind a b; do
    case "$kind" in
      TIER)    ok "tier $a -> $b" ;;
      UNBOUND) warn "tier '$a': $b"
               todo_add "     bind the '$a' tier — re-run ./scripts/install.sh --section tiers after adding a provider that can serve it" ;;
    esac
  done < "$SCRATCH/gen.out"

  # Defensive re-check of this script's own output. bin/pi-check rule PC-06 only scans files git
  # TRACKS, and these two are deliberately ignored — so a credential pasted into an endpoint
  # prompt would slip past it. A shape check only; no value is ever printed.
  if grep -qE '(sk-|gho_|ghp_|dapi)[A-Za-z0-9_-]{16,}' "$GEN_MODELS" "$GEN_ROUTING" 2>/dev/null; then
    die "PI-INSTALL-E28" "the generated config contains a value shaped like a literal secret" \
        "one of your endpoint answers looks like a credential; secrets belong in $SECRETS_FILE as \$VARIABLE references — re-run and answer with endpoints only"
  fi
  ok "no secret-shaped literal in the generated config"
fi

# The remaining config files are patched, not generated wholesale, so each one has to exist
# first. materialize() copies the tracked template into place the first time and does nothing
# afterwards — which is what keeps a second run at "0 step(s) changed".
_mat_new=""; _mat_kept=0
for _c in $GENERATED_CONFIGS; do
  if materialize "$_c"; then _mat_new="$_mat_new $_c.json"; else _mat_kept=$((_mat_kept + 1)); fi
done
[ -z "$_mat_new" ] || changed "created from templates:$_mat_new"
[ "$_mat_kept" = 0 ] || ok "$_mat_kept generated config file(s) already present — yours are patched, the templates are not"

# ------------------------------------------------------------------------------ apply: MCP ----
if [ -f "$MCP_FILE" ] && [ -z "$MCP_PICKED" ]; then
  ok "config/mcp.json left alone"
elif [ -f "$REPO_DIR/config/mcp.default.json" ]; then
  if [ ! -f "$MCP_FILE" ]; then
    run "cp '$REPO_DIR/config/mcp.default.json' '$MCP_FILE'"
    manifest_add GENERATED "$MCP_FILE" "copied from mcp.default.json"
    [ -n "$MCP_PICKED" ] || changed "config/mcp.json from the default template (no servers — opt in later)"
  fi
  # The two entries are written exactly as config/mcp.example.json documents them, including the
  # ${VAR} references: the key itself never lands in this file, only the name of the variable
  # holding it. mcp-stdio-guard is what makes the stdio server safe to run at all — it execs the
  # child with an empty environment plus MCP_STDIO_EXTRA_ENV's allowlist, so a browser driver
  # fetched from npm cannot read the API keys sitting in this shell.
  case " $MCP_PICKED " in
    *" context7 "*)
      cfg_set "$MCP_FILE" 'mcpServers.context7=json:{
        "url": "https://mcp.context7.com/mcp",
        "headers": {"CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"},
        "lifecycle": "lazy",
        "directTools": true
      }' ;;
  esac
  case " $MCP_PICKED " in
    *" playwright "*)
      cfg_set "$MCP_FILE" 'mcpServers.playwright=json:{
        "command": "mcp-stdio-guard",
        "args": ["npx", "-y", "@playwright/mcp", "--headless"],
        "env": {
          "MCP_STDIO_EXTRA_ENV": "PLAYWRIGHT_BROWSERS_PATH",
          "PLAYWRIGHT_BROWSERS_PATH": "${HOME}/.cache/ms-playwright"
        },
        "lifecycle": "lazy"
      }' ;;
  esac
  # Asserted rather than assumed: hostConfigDiscovery must stay "off" whatever the template said,
  # or PI starts adopting MCP servers configured for other tools on this machine.
  cfg_set "$MCP_FILE" "settings.hostConfigDiscovery=off"
fi

# settings.json
cfg_set "$SETTINGS_FILE" \
  "defaultProvider=$(ans_get settings.defaultProvider)" \
  "defaultModel=$(ans_get settings.defaultModel)" \
  "defaultThinkingLevel=$(ans_get settings.defaultThinkingLevel)" \
  "theme=str:$(ans_get settings.theme)" \
  "externalEditor=str:$(ans_get settings.externalEditor)" \
  "tuiMode=$(ans_get settings.tuiMode)"

# guard.json — protected branches only. The 2026-08-14 deny-list inversion left nothing else in
# this file to configure: the catastrophic-command set is in code, not data.
_pb="$(ans_get guard.protectedBranches)"
[ -z "$_pb" ] || cfg_set "$GUARD_FILE" "protectedBranches=[$_pb]"

# trusted-roots.json — machine-specific filesystem roots, derived from this machine, never
# inherited from whoever built the repo.
_roots="$(ans_get trust.roots)"
# shellcheck disable=SC2088  # the literal ~ is written into JSON on purpose; PI expands it at read time
cfg_set "$TRUST_FILE" "roots=[$_roots,$( [ "$PREFIX" = "$HOME" ] && printf '~/pi-config' || printf '%s' "$STABLE_LINK" )]"
# path-defaults.json — no per-directory routing any more: one configured tier and one egress
# policy for every session, so there is nothing here to derive from trust.roots. The installer
# still writes the file (rather than leaving the template as the active config) so a fresh install
# ends up with a real config/path-defaults.json, not just its .default.json twin.
cfg_set "$PATHS_FILE" \
  "tier=strong" \
  "egress=json:{\"web\": \"allow\", \"mcp\": \"allow\", \"publicModels\": \"allow\"}"

# web.json / web-search.json — the two must agree, and extensions/web asserts it at every start.
case "$(ans_get web.backend)" in
  searxng)
    cfg_set "$WEB_FILE" "search.backend=searxng"
    cfg_set "$WEBSEARCH_FILE" "provider=searxng" "searxngBaseUrl=str:$(ans_get web.searxngBaseUrl)" "webSearch.enabled=true" ;;
  tavily|brave|exa)
    # No key here, deliberately: pi-web-access falls back to TAVILY_API_KEY/BRAVE_API_KEY/EXA_API_KEY
    # from the environment, which is where the credentials step below puts it. Writing the key into
    # web-search.json would be a secret in a config file this repository tracks.
    cfg_set "$WEB_FILE" "search.backend=$(ans_get web.backend)"
    cfg_set "$WEBSEARCH_FILE" "provider=$(ans_get web.backend)" "webSearch.enabled=true" ;;
  *)
    cfg_set "$WEB_FILE" "search.backend=none"
    cfg_set "$WEBSEARCH_FILE" "provider=none" "webSearch.enabled=false"
    info "web_search is disabled — PI will say so rather than returning empty results"
    info "web_fetch is unaffected and still needs no key: extraction falls back to Jina Reader (r.jina.ai)" ;;
esac

[ ! -f "$(cfg_seed quota)" ] || cfg_set "$QUOTA_FILE" "quota.enabled=$(ans_get quota.enabled)"

if [ "$(ans_get lsp.install)" = "1" ] && [ "$DRY_RUN" = 0 ]; then
  for _pkg in typescript-language-server typescript; do
    if run "npm install -g --ignore-scripts '$_pkg'"; then
      manifest_add NPMGLOBAL "$_pkg" "TypeScript diagnostics dependency (best-effort: npm install -g $_pkg)"
    else
      warn "npm install -g $_pkg failed — install it by hand if you want TS diagnostics"
    fi
  done
  changed "language servers installed globally via npm"
fi

# ------------------------------------------------------- apply: the extension packages ---------
# config/settings.json's `packages` array points at <repo>/node_modules/*. Without them PI starts
# and every packaged extension is simply absent — statusline, subagents, web access, LSP. That is
# the difference between "installed" and "works", so it happens here rather than in a README.
step "Extension packages"
if [ "$SKIP_PACKAGES" = 1 ]; then
  ok "npm install skipped (--skip-packages)"
  SKIPPED="$SKIPPED
     the extension packages (--skip-packages) — settings.json references node_modules/*"
  todo_add "     run: (cd $STABLE_LINK && npm install --ignore-scripts)   # the packaged extensions"
elif [ -d "$REPO_DIR/node_modules" ]; then
  ok "node_modules is present — the packaged extensions are installed"
elif [ "$OFFLINE" = 1 ]; then
  warn "offline: cannot fetch the extension packages"
  todo_add "     run: (cd $STABLE_LINK && npm install --ignore-scripts)   # needs network; the packaged extensions"
elif ! command -v npm >/dev/null 2>&1; then
  warn "npm is not on PATH, so the packaged extensions cannot be installed"
  todo_add "     install npm, then: (cd $STABLE_LINK && npm install --ignore-scripts)"
else
  info "installing the packaged extensions listed in package.json (this is the slow step)"
  # --ignore-scripts is not optional: a package lifecycle script runs arbitrary code from the
  # registry at install time, and nothing here needs one.
  if run "(cd '$REPO_DIR' && npm install --ignore-scripts)"; then
    changed "extension packages installed into $REPO_DIR/node_modules"
    manifest_add DIR "$REPO_DIR/node_modules" "npm packages for the extensions"
  else
    warn "npm install failed — PI will start, but every packaged extension will be missing"
    todo_add "     run: (cd $STABLE_LINK && npm install --ignore-scripts) and read the npm error"
  fi
fi

# ------------------------------------------------------------------------ apply: symlinks ------
step "Linking the config into $AGENT_DIR"
info "PI reads ~/.pi/agent/. Each entry there is a symlink into this repo, so editing a file here"
info "changes the live agent immediately, and a git pull updates it. Nothing is copied."

link_one() { # link_one <required|optional> <repo-relative source> <name under AGENT_DIR>
  local req="$1" src="$STABLE_LINK/$2" dst="$AGENT_DIR/$3"
  if [ ! -e "$REPO_DIR/$2" ]; then
    # A dry run did not actually generate the config/*.json files, so their absence here is
    # expected rather than a broken clone. Reporting them as fatal would make --dry-run fail on a
    # machine where the real run would succeed, which is worse than useless. The test is "does the
    # tracked template exist", so the list cannot go stale the way an enumeration would.
    if [ "$DRY_RUN" = 1 ] && [ -f "$REPO_DIR/${2%.json}.default.json" ]; then
      printf '   %sdry-run%s %s -> %s (after generation)\n' "$C_D" "$C_0" "$3" "$src"; return 0
    fi
    if [ "$req" = "required" ]; then
      die "PI-INSTALL-E18" "the repo is missing '$2', which is a required config entry" \
          "re-clone the repository — the config tree is incomplete without it"
    fi
    info "$3 is not in this repo — skipped (optional)"
    return 0
  fi
  if [ "$(readlink "$dst" 2>/dev/null || true)" = "$src" ]; then ok "$3"
  else
    [ ! -e "$dst" ] || [ -L "$dst" ] || backup_file "$dst"
    run "ln -sfn '$src' '$dst'"
    changed "$3 -> $src"
  fi
  manifest_add LINK "$dst" "$src"
}

# NOTE: `extensions` is deliberately NOT linked. PI discovers <agentDir>/extensions/*.ts and
# would load all of them as separate extensions in readdir order — breaking the fixed ORDER that
# puts `guard` before `bash`, and failing every module without a default export.
# config/settings.json names <repo>/extensions/index.ts explicitly instead.
link_one required config/settings.json      settings.json
link_one required config/models.json        models.json
link_one required config/routing.json       routing.json
if [ "$(ans_get skills.dir)" = "1" ]; then
  if [ -d "$SKILLS_DIR" ]; then ok "skills/ (your own skills)"
  else
    run "mkdir -p '$SKILLS_DIR'"
    changed "$SKILLS_DIR — git-ignored, already a skill search path in settings.json"
    manifest_add DIR "$SKILLS_DIR"
  fi
  # One line, deliberately: the summary numbers this list by line, so an embedded newline turns
  # one manual step into two.
  # docs/extending/skills.md, not skills-portability.md: the repo ships zero skills, so this link
  # is the whole on-ramp to writing one. The portability page is about moving frontmatter between
  # harnesses, which is a later problem.
  todo_add "     (optional) write your first skill: $SKILLS_DIR/<name>/SKILL.md — see https://dresvyanskiydenis.github.io/PiON/extending/skills/"
fi

# `skills` is optional, and in a fresh clone it is absent: the public harness ships the skill
# *loading mechanism* and no skills. settings.json lists ~/.pi/agent/skills as its ONE search
# path, and PI treats a missing search path as "no skills here" rather than an error — so the
# link is made once the step above has created the directory, or by a fork that added one.
link_one optional skills                    skills
link_one required prompts                   prompts

# The prompt layer, in the order PI assembles it. `SYSTEM.md` REPLACES pi's built-in base prompt
# (PI looks for `<cwd>/.pi/SYSTEM.md` in a trusted project first, then `<agentDir>/SYSTEM.md`);
# `APPEND_SYSTEM.md` only appends to whichever base is in force; `AGENTS.md` arrives later still,
# as a quoted project-context block. SYSTEM.md is `required`: an optional row would let a broken
# clone fall back to the stock vendor prompt with nothing louder than a skip line, and that
# substitution is invisible from inside a session.
link_one required AGENTS.md                 AGENTS.md
link_one required SYSTEM.md                 SYSTEM.md
link_one optional config/APPEND_SYSTEM.md   APPEND_SYSTEM.md
link_one optional config/keybindings.json   keybindings.json
link_one optional themes                    themes
link_one optional agents                    agents
link_one optional agents-private            agents-private
# Every remaining file a module resolves through configDir() (== $AGENT_DIR) rather than through
# the repo root. Without the link the owning module falls back to its built-in default, which is
# exactly the silent degradation this harness forbids.
link_one optional config/mcp.json           mcp.json
link_one required config/web.json           web.json
link_one required config/web-search.json    web-search.json
link_one required config/hooks.yaml         hooks.yaml
link_one optional config/guard.json         guard.json
link_one optional config/digest.json        digest.json
link_one optional config/quota.json         quota.json
link_one optional config/path-defaults.json path-defaults.json
link_one optional config/trusted-roots.json trusted-roots.json
link_one optional config/pi-statusline.json pi-statusline.json
link_one optional config/pi-lsp.json        pi-lsp.json

# pi-subagents reads exactly one path — getAgentDir()/extensions/subagent/config.json (its
# extension/config.ts getConfigPath()) — so its destination is nested. The directory is PI runtime
# state and PI does not create it, hence the mkdir. Only the single file is linked: linking
# $AGENT_DIR/extensions itself would hand PI our extension SOURCE tree, which the NOTE above the
# "Linking the config" step explains at length. pi-lean-ctx below follows the identical pattern.
run "mkdir -p '$AGENT_DIR/extensions/subagent'"
link_one optional config/subagent.json      extensions/subagent/config.json

# The `subagent` tool's own model-facing description, which the file above switches on with
# `toolDescriptionMode: "custom"`. pi-subagents resolves it as <cwd>/.pi/subagent-tool-description.md
# then <agentDir>/subagent-tool-description.md, so the destination is the agent-dir ROOT — not the
# nested extensions/subagent/ directory the config file goes to. `required`, because a missing file
# does not restore the package's short default description: it installs the 6 KB full one, whose
# worked example routes to a role this configuration does not have and whose guidelines mandate an
# { action: "list" } round trip before every delegation, behind one console.warn.
link_one required config/subagent-tool-description.md subagent-tool-description.md

# pi-lean-ctx reads getAgentDir()/extensions/pi-lean-ctx/config.json. Shipping the file matters even
# though every key in it is optional: with enableMcp at the package default of true, pi-lean-ctx
# spawns the `lean-ctx` binary as an MCP server at every session start, and on a machine that has
# not run `cargo install lean-ctx` that is a failed spawn plus three backoff retries — seven stderr
# lines on every startup, for a feature that cannot work yet.
run "mkdir -p '$AGENT_DIR/extensions/pi-lean-ctx'"
link_one optional config/lean-ctx-config.json extensions/pi-lean-ctx/config.json

if [ -d "$REPO_DIR/config/bin" ]; then
  for helper in "$REPO_DIR"/config/bin/*; do
    [ -f "$helper" ] || continue
    name="$(basename "$helper")"
    if [ "$(readlink "$BIN_DIR/$name" 2>/dev/null || true)" = "$STABLE_LINK/config/bin/$name" ]; then ok "bin/$name"
    else
      run "chmod 0755 '$helper'"
      run "ln -sfn '$STABLE_LINK/config/bin/$name' '$BIN_DIR/$name'"
      changed "bin/$name -> $STABLE_LINK/config/bin/$name"
    fi
    manifest_add LINK "$BIN_DIR/$name" "$STABLE_LINK/config/bin/$name"
  done
fi

# The two tools that live at the repo root's bin/ rather than config/bin/, so they do not fall
# into the loop above: pi-run, the fail-closed headless wrapper, and pi-check, this repo's own
# verification gate — which docs/getting-started/first-run.md step 1 invokes as a bare command, so
# leaving it off PATH makes a colleague's first action after a successful install a
# `command not found`. Linking is safe for both: each resolves its repo root from
# `import.meta.url` rather than from $PWD, so the link resolves back through itself to the
# checkout and the tool works from any directory.
for root_tool in pi-run pi-check; do
  [ -f "$REPO_DIR/bin/$root_tool" ] || continue
  if [ "$(readlink "$BIN_DIR/$root_tool" 2>/dev/null || true)" = "$STABLE_LINK/bin/$root_tool" ]; then ok "bin/$root_tool"
  else
    run "chmod 0755 '$REPO_DIR/bin/$root_tool'"
    run "ln -sfn '$STABLE_LINK/bin/$root_tool' '$BIN_DIR/$root_tool'"
    changed "bin/$root_tool -> $STABLE_LINK/bin/$root_tool"
  fi
  manifest_add LINK "$BIN_DIR/$root_tool" "$STABLE_LINK/bin/$root_tool"
done

for state in auth.json trust.json sessions models-store.json; do
  if [ -L "$AGENT_DIR/$state" ]; then
    die "PI-INSTALL-E19" "$AGENT_DIR/$state is a symlink into the repo" \
        "credentials, trust decisions and transcripts must never live in git — remove the symlink and re-run"
  fi
done
ok "runtime state (auth.json, trust.json, sessions/) stays PI-owned and is never linked into git"

# ---------------------------------------------------------------------- apply: credentials ----
step "Credentials"

secrets_ensure_file() {
  if [ ! -f "$SECRETS_FILE" ]; then
    if [ "$DRY_RUN" = 1 ]; then printf '   %sdry-run%s create %s (0600)\n' "$C_D" "$C_0" "$SECRETS_FILE"; return 0; fi
    ( umask 077
      printf '# PiON secrets — sourced by config/shell/pi-env.sh.\n' > "$SECRETS_FILE"
      printf '# One KEY=value per line. chmod 0600. Not part of any repository.\n' >> "$SECRETS_FILE" )
    changed "created $SECRETS_FILE (0600)"
    manifest_add SECRETS "$SECRETS_FILE" "your credentials — never deleted without asking"
  fi
  [ "$DRY_RUN" = 1 ] || chmod 0600 "$SECRETS_FILE"
}
# Replaces any existing definition of VAR, then appends `line`. Written through a 0600 temp file
# in the same directory, so the value is never world-readable, not even for an instant.
secrets_put() {
  local var="$1" line="$2" tmp
  secrets_ensure_file
  if [ "$DRY_RUN" = 1 ]; then printf '   %sdry-run%s define %s in %s\n' "$C_D" "$C_0" "$var" "$SECRETS_FILE"; return 0; fi
  # Already exactly this line: say so and touch nothing. Rewriting it would report a change on
  # every re-run, which is precisely the noise that makes people stop reading the output. The
  # comparison is on the whole line, so a CHANGED value is still rewritten.
  if [ -f "$SECRETS_FILE" ] && grep -qxF "$line" "$SECRETS_FILE" 2>/dev/null; then
    ok "$var already defined in $SECRETS_FILE with this value"
    return 0
  fi
  tmp="$SECRETS_FILE.tmp.$$"
  ( umask 077
    grep -v "^\(export \)\{0,1\}$var=" "$SECRETS_FILE" 2>/dev/null | grep -v "$var=.*find-generic-password" > "$tmp" || true
    printf '%s\n' "$line" >> "$tmp" )
  mv "$tmp" "$SECRETS_FILE"; chmod 0600 "$SECRETS_FILE"
  changed "$var stored in $SECRETS_FILE"
}

if [ -s "$CRED_ACTIONS" ]; then
  while IFS=$'\037' read -r a_prov a_env a_mode a_svc; do
    [ -n "$a_env" ] || continue
    case "$a_mode" in
      keep) ok "$a_env already available — untouched" ;;
      secretsfile)
        if [ "$INTERACTIVE" = 0 ] || [ "$DRY_RUN" = 1 ]; then
          warn "$a_env cannot be typed in this mode — deferring it"
          todo_add "     echo '$a_env=<your value>' >> $SECRETS_FILE && chmod 0600 $SECRETS_FILE   # provider: $a_prov"
        else
          _val="$(ask_secret "$a_env for $a_prov")"
          if [ -z "$_val" ]; then
            warn "nothing typed — deferring $a_env"
            todo_add "     echo '$a_env=<your value>' >> $SECRETS_FILE && chmod 0600 $SECRETS_FILE   # provider: $a_prov"
          else
            secrets_put "$a_env" "$a_env=$_val"
            unset _val
          fi
        fi ;;
      keychain)
        if [ "$DRY_RUN" = 1 ]; then
          printf '   %sdry-run%s security add-generic-password -a "$USER" -s %s -U -w\n' "$C_D" "$C_0" "$a_svc"
        else
          # `-w` LAST and empty makes `security` prompt on the tty, so the secret never appears
          # in this process's argv where `ps` would show it to every user on the machine.
          info "the Keychain will now prompt you for $a_env"
          security add-generic-password -a "$USER" -s "$a_svc" -U -w < /dev/tty || \
            die "PI-INSTALL-E29" "the Keychain refused to store '$a_svc'" \
                "run: security add-generic-password -a \"\$USER\" -s $a_svc -U -w  — then re-run with --repair"
          manifest_add KEYCHAIN "$a_svc" "keychain item for $a_env"
        fi
        # The lookup goes in the SHELL env file, never in models.json: a `!security ...` reference
        # inside models.json would be re-executed on EVERY LLM call — one Keychain read per
        # request instead of one per shell.
        secrets_put "$a_env" \
          "[ -n \"\${$a_env:-}\" ] || $a_env=\"\$(security find-generic-password -a \"\$USER\" -s $a_svc -w 2>/dev/null)\"" ;;
      later)
        todo_add "     echo '$a_env=<your value>' >> $SECRETS_FILE && chmod 0600 $SECRETS_FILE   # provider: $a_prov" ;;
    esac
  done < "$CRED_ACTIONS"
else
  ok "no provider declared a credential"
fi

# Non-secret provider environment (DATABRICKS_HOST, PI_LOCAL_BASE_URL, ...). Same file as the
# secrets on purpose: it is the one place both an interactive shell and a headless run read, and
# writing them into the tracked config/shell/pi-env.sh would make `git pull` conflict per machine.
if [ -s "$ENV_PLAN" ]; then
  while IFS=$'\037' read -r e_prov e_name e_suggest e_required e_desc; do
    [ -n "$e_name" ] || continue
    _v="$(ans_get "env.$e_name")"
    if [ -z "$_v" ]; then
      if eval "[ -n \"\${$e_name:-}\" ]"; then ok "\$$e_name comes from your environment already"; continue; fi
      [ "$e_required" = 1 ] && todo_add "     export $e_name=<value> — the $e_prov provider reads it ($e_desc)"
      continue
    fi
    secrets_put "$e_name" "$e_name=$_v"
  done < "$ENV_PLAN"
fi

# README §2.6: the fragments' notes are measured facts about real endpoints, and a human editing
# the generated models.json later should read them first. Keeping them next to the generated file
# is what makes that possible without going back to the repository.
if [ "$DRY_RUN" = 0 ] && [ -s "$NOTES_LOG" ]; then
  { printf '# Provider notes — the reasoning behind your config/models.json\n\n'
    printf 'Written by scripts/install.sh on %s, from config/providers/*.json.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'These are measured facts, not opinions. Read them before hand-editing models.json.\n'
    cat "$NOTES_LOG"; } > "$AGENT_DIR/provider-notes.md"
  manifest_add FILE "$AGENT_DIR/provider-notes.md" "why your models.json looks the way it does"
  ok "provider notes written to $AGENT_DIR/provider-notes.md"
fi

# --------------------------------------------------------------------------- apply: shell -----
step "Shell integration"

if [ "$DO_SHELL" = 0 ]; then
  ok "shell rc files untouched"
  SKIPPED="$SKIPPED
     shell rc modification"
else
  _proxy="$(ans_get web.proxy)"
  for rc in $RC_CANDIDATES; do
    if [ ! -f "$rc" ]; then
      if [ "$DRY_RUN" = 0 ]; then : > "$rc"; fi
      manifest_add FILE "$rc" "created by the installer (it did not exist)"
    fi
    if grep -qF "$MARKER" "$rc" 2>/dev/null; then ok "$(basename "$rc") already has the pi-config block"
    else
      if [ "$DRY_RUN" = 0 ]; then
        { printf '\n%s\n' "$MARKER"
          printf 'export PATH="%s:$PATH"\n' "$RC_BIN"
          printf '[ -f "%s" ] && . "%s"\n' "$RC_ENV" "$RC_ENV"
          if [ -n "$_proxy" ]; then
            printf 'export HTTPS_PROXY="%s"; export HTTP_PROXY="$HTTPS_PROXY"\n' "$_proxy"
            printf 'export NO_PROXY="127.0.0.1,localhost,::1,.local"; export no_proxy="$NO_PROXY"\n'
          fi
          printf '%s\n' "$MARKER_END"; } >> "$rc"
      fi
      changed "$(basename "$rc"): appended the pi-config block"
    fi
    manifest_add RCBLOCK "$rc" "$MARKER"
  done

  # .zshrc is NOT read by a non-interactive shell, so `bin/pi-run` under cron or launchd would
  # start with no credentials at all. This second, smaller block closes that — a measured gap,
  # not a hypothetical one.
  ZSHENV="$PREFIX/.zshenv"
  if command -v zsh >/dev/null 2>&1 || [ -f "$ZSHENV" ]; then
    # Recorded before it is written, exactly as for the interactive rc files: if the installer is
    # what brought .zshenv into existence, the uninstaller is allowed to take the empty file away
    # again. Without this row it would strip the block and leave an orphan behind.
    [ -f "$ZSHENV" ] || manifest_add FILE "$ZSHENV" "created by the installer (it did not exist)"
    if [ -f "$ZSHENV" ] && grep -qF "$MARKER_H" "$ZSHENV" 2>/dev/null; then
      ok ".zshenv already sources secrets.env for headless runs"
    else
      if [ "$DRY_RUN" = 0 ]; then
        { printf '\n%s\n' "$MARKER_H"
          printf 'export PATH="%s:$PATH"\n' "$RC_BIN"
          printf '[ -r "%s" ] && { set -a; . "%s"; set +a; }\n' "$RC_SEC" "$RC_SEC"
          printf '%s\n' "$MARKER_H_END"; } >> "$ZSHENV"
      fi
      changed "$(basename "$ZSHENV"): appended the headless block (cron and launchd runs get credentials)"
    fi
    manifest_add RCBLOCK "$ZSHENV" "$MARKER_H"
  else
    info "zsh is not installed — the headless block was not needed"
  fi

  case ":$PATH:" in *":$BIN_DIR:"*) ok "$BIN_DIR is already on PATH in this shell" ;;
    *) todo_add "     start a new shell (or run: exec \$SHELL -l) so $BIN_DIR reaches your PATH" ;;
  esac
fi

# --------------------------------------------------------------------- apply: auto-update -----
step "Auto-update"

# The preference is written whatever the answer was. "off" recorded in the file is not the same
# state as "no file": the check script reads this to decide whether to do anything at all, and a
# cron entry added by hand against a missing config would then run against the shipped default
# rather than against a decision anybody made.
cfg_set "$AUTOUPDATE_FILE" \
  "autoUpdate.enabled=json:$AUTOUPDATE_ENABLED" \
  "autoUpdate.mode=str:$(ans_get autoupdate.mode)" \
  "autoUpdate.intervalMinutes=json:$AUTOUPDATE_INTERVAL"

if ! command -v crontab >/dev/null 2>&1; then
  # Not a failure: containers, minimal images and locked-down laptops routinely have no cron at
  # all. The preference is still recorded, the check script still works by hand, and the one
  # thing that cannot happen silently is the schedule going missing.
  if [ "$AUTOUPDATE_ENABLED" = true ]; then
    warn "crontab is not on PATH — the periodic check could not be scheduled"
    todo_add "     schedule the update check yourself (launchd, a systemd timer, your own runner): $AUTOUPDATE_SCRIPT, every $AUTOUPDATE_INTERVAL minutes"
  else
    ok "crontab is not on PATH — nothing to schedule and nothing to remove"
  fi
elif [ "$DRY_RUN" = 1 ]; then
  if [ "$AUTOUPDATE_ENABLED" = true ]; then
    printf '   %sdry-run%s crontab: add %s\n' "$C_D" "$C_0" "$CRON_LINE"
  else
    printf '   %sdry-run%s crontab: remove any line marked %s\n' "$C_D" "$C_0" "$CRON_MARK"
  fi
else
  # Read-modify-write of the WHOLE crontab, filtered on our marker. `crontab -l | { cat; echo; } |
  # crontab -` is the usual one-liner and it appends unconditionally, so a second install leaves
  # two entries and a third leaves three. Filtering first makes add and replace the same
  # operation, and makes "already there" a comparison rather than a grep.
  CRON_CUR="$SCRATCH/crontab.cur"; CRON_NEW="$SCRATCH/crontab.new"
  # A user with no crontab at all makes `crontab -l` exit 1 with "no crontab for <user>" — a
  # normal state, not an error, and the reason this is not `set -e`'s business.
  crontab -l > "$CRON_CUR" 2>/dev/null || : > "$CRON_CUR"
  grep -vF "$CRON_MARK" "$CRON_CUR" > "$CRON_NEW" 2>/dev/null || : > "$CRON_NEW"
  [ "$AUTOUPDATE_ENABLED" = false ] || printf '%s\n' "$CRON_LINE" >> "$CRON_NEW"
  if cmp -s "$CRON_CUR" "$CRON_NEW"; then
    if [ "$AUTOUPDATE_ENABLED" = true ]; then ok "the cron entry is already exactly: $CRON_LINE"
    else ok "no auto-update cron entry to remove"; fi
  elif crontab "$CRON_NEW"; then
    if [ "$AUTOUPDATE_ENABLED" = true ]; then changed "crontab: $CRON_LINE"
    else changed "crontab: removed the auto-update entry"; fi
  else
    # `crontab` refuses on a machine where cron is disabled by policy, and on macOS without Full
    # Disk Access for the calling terminal. Both are worth the user's attention and neither is
    # worth aborting an otherwise complete install for.
    warn "crontab refused the new table — the schedule was NOT changed"
    todo_add "     'crontab $CRON_NEW' was refused (on macOS this is usually Full Disk Access for your terminal). Add or remove the line marked '$CRON_MARK' with 'crontab -e' yourself"
  fi
  [ "$AUTOUPDATE_ENABLED" = false ] || manifest_add CRON "$AUTOUPDATE_SCRIPT" "$CRON_MARK"
fi

# Endpoints and choices only. ask_secret()'s values were never put in this store, by construction.
if [ "$DRY_RUN" = 0 ]; then
  { printf '# Written by scripts/install.sh on %s.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '# Re-run unattended with:  ./scripts/install.sh --answers %s --yes\n' "$ANSWERS_OUT"
    printf '# Endpoints and choices only. It contains NO credential values.\n'
    sort "$ANSWERS"; } > "$ANSWERS_OUT"
  chmod 0644 "$ANSWERS_OUT"
  manifest_add FILE "$ANSWERS_OUT" "your saved answers"
  ok "answers saved to $ANSWERS_OUT"
fi
manifest_add FILE "$MANIFEST" "this manifest"

# ================================================================= validate and hand off ========
step "Checking the result"

FINAL_EXIT=0
if [ "$DRY_RUN" = 1 ]; then
  info "a real run would now execute bin/pi-check --all and scripts/postinstall-verify.sh"
elif [ -x "$REPO_DIR/bin/pi-check" ]; then
  if "$REPO_DIR/bin/pi-check" --all; then ok "pi-check passed — the config is internally consistent"
  else
    # Deliberately NOT `die`. Everything above has already been written, and aborting here would
    # neither undo it nor tell the user what state they are in. The findings are printed above,
    # the exit code is non-zero so CI still fails, and the summary below still runs.
    warn "bin/pi-check reported the findings above — the install itself completed"
    todo_add "     fix the bin/pi-check findings printed above, then re-run: $STABLE_LINK/bin/pi-check --all"
    FINAL_EXIT=1
  fi
else
  warn "bin/pi-check is not executable — the configuration was NOT shape-validated"
fi

if [ "$DRY_RUN" = 1 ]; then
  : # already reported above; a dry run verifies nothing because it wrote nothing
elif [ "$RUN_VERIFY" = 1 ] && [ -x "$REPO_DIR/scripts/postinstall-verify.sh" ]; then
  run "PI_CODING_AGENT_DIR='$AGENT_DIR' PI_INSTALL_PREFIX='$PREFIX' '$REPO_DIR/scripts/postinstall-verify.sh'" || \
    warn "postinstall-verify.sh reported failures — the install completed; read its table above"
elif [ "$RUN_VERIFY" = 1 ]; then
  warn "scripts/postinstall-verify.sh not found — skipping verification"
else
  ok "verification skipped (--no-verify)"
  SKIPPED="$SKIPPED
     post-install verification (--no-verify)"
fi

# ==================================================================================== summary ===
printf '\n%s\n' "-----------------------------------------------------------------------"
printf '%s  Done — %s step(s) changed%s\n' "$C_B" "$CHANGED" "$C_0"
printf '\nWhat you now have:\n'
printf '   providers    %s\n' "$SELECTED"
printf '   pi           %s (%s), at %s/pi\n' "$PI_VERSION_EXPECTED" "$( [ "$SKIP_RUNTIME" = 1 ] && printf untouched || printf '%s' "$MODE" )" "$BIN_DIR"
printf '   live config  %s -> %s\n' "$AGENT_DIR" "$STABLE_LINK"
# Read back from the file, for the same reason as the MCP line below: section 6 asks for the
# protected branches only on the long path, so on --express the ANSWER is empty while the tracked
# template still ships main,master and the guard write correctly skips an empty value. Printing the
# answer told the express user — the one most likely to be reading this line at all — that nothing
# was protected, which was never true.
_pb_now="$(ans_get guard.protectedBranches)"
if [ -z "$_pb_now" ]; then
  for _pb_file in "$GUARD_FILE" "$REPO_DIR/config/guard.default.json"; do
    [ -f "$_pb_file" ] || continue
    _pb_now="$(tr -d '\n' < "$_pb_file" | sed -n 's/.*"protectedBranches"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' | tr -d '" ')"
    [ -n "$_pb_now" ] && break
  done
fi
printf '   safety       DB-*/GIT-REWRITE/GIT-FORCE-PROTECTED always refuse; SEC-* records credential paths without refusing them; protected branches: %s\n' "${_pb_now:-none}"
# Read back from the file rather than reported from the answer: on a re-run the MCP step stands
# down (mcp.json is already yours), so $MCP_PICKED is empty even though servers are configured,
# and a summary that then says "none" is simply wrong.
_mcp_now=""
if [ -f "$MCP_FILE" ]; then _mcp_now="$(json keys "$MCP_FILE" mcpServers 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"; fi
[ -n "$_mcp_now" ] || _mcp_now="$MCP_PICKED"
printf '   mcp servers  %s\n' "${_mcp_now:-none — config/mcp.example.json is the annotated template}"
if [ "$(ans_get skills.dir)" = "1" ]; then
  printf '   your skills  %s/<name>/SKILL.md   (git-ignored; the repo ships none)\n' "$SKILLS_DIR"
fi
# Read back from the file for the same reason as the two lines above it: on --repair and on
# --section <anything-else> the question was never asked this run, so the ANSWER is whatever the
# previous run stored while the file is what the check script will actually obey.
_au_now="$(json get "$AUTOUPDATE_FILE" autoUpdate.enabled 2>/dev/null || printf 'false')"
if [ "$_au_now" = true ]; then
  printf '   auto-update  every %s min -> %s, then %s at the next session\n' \
    "$AUTOUPDATE_INTERVAL" "$AGENT_DIR/update-pending" "$(json get "$AUTOUPDATE_FILE" autoUpdate.mode 2>/dev/null || printf 'prompt')"
else
  printf '   auto-update  off  (turn it on later: ./scripts/install.sh --section maintenance)\n'
fi
printf '   answers      %s   (re-run with --answers to reproduce this exactly)\n' "$ANSWERS_OUT"
printf '   manifest     %s   (uninstall.sh reads this)\n' "$MANIFEST"
[ -z "$SKIPPED" ] || printf '\nSkipped:%s\n' "$SKIPPED"
[ -z "$BACKUPS" ] || printf '\nBacked up (nothing was overwritten in place):%s\n' "$BACKUPS"

if [ -n "$MANUAL_TODO" ]; then
  printf '\n%sStill yours to do by hand:%s\n' "$C_CH" "$C_0"
  _n=0
  printf '%s\n' "$MANUAL_TODO" | while IFS= read -r t; do
    [ -n "$t" ] || continue
    _n=$((_n + 1))
    # The entries carry their own indentation for the review screen; strip it so the numbering
    # lines up here.
    printf '  %d. %s\n' "$_n" "$(printf '%s' "$t" | sed 's/^ *//')"
  done
else
  printf '\n%sNothing is left for you to do by hand.%s\n' "$C_OK" "$C_0"
fi

printf '\nNext:\n'
printf '   exec $SHELL -l      # so PATH and the env file are loaded\n'
printf '   pi                  # start the agent\n'
# Wording matters here. This harness has no provider failover: a request to a provider whose
# credential is missing ABORTS and names it. What still works is everything bound to a provider
# you did configure. Saying "it falls back to another provider" would describe a different,
# explicitly rejected design.
printf '\nA missing provider credential does not stop PI from starting: it reports which provider is\n'
printf 'unconfigured, and every tier bound to a provider you did configure keeps working. A request\n'
printf 'that needs the missing one fails loudly, naming it — nothing is silently sent elsewhere.\n'
printf 'To change anything later:  ./scripts/install.sh --reconfigure   (or --section providers)\n'
printf 'To remove all of it:       ./scripts/uninstall.sh              (it reads the manifest above)\n'
# Both forms on purpose: the relative path for somebody sitting in the clone, the URL for somebody
# reading this output pasted into a chat window a week later.
printf 'Docs:                      docs/getting-started/first-run.md\n'
printf '                           https://dresvyanskiydenis.github.io/PiON/\n'
[ "$DRY_RUN" = 0 ] || printf '\n%sThis was a dry run — nothing above was actually written.%s\n' "$C_CH" "$C_0"

# Non-zero when a checker found something, so a CI job notices, but only AFTER the summary and the
# manual-steps list have been printed — an exit code is not a substitute for telling the user.
exit "${FINAL_EXIT:-0}"
