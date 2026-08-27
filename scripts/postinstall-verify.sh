#!/usr/bin/env bash
# postinstall-verify.sh — post-install self-check: is the install this repo just made actually live?
#
# Distinct from scripts/verify-environment.sh, which is the pre-install *environment probe*
# (does this machine even have what PI needs). This script checks a machine AFTER
# ./scripts/install.sh has run: the deployed symlinks, the pinned binary, the guardrail, and
# (opt-in only) a live model round trip / credential resolution. install.sh's own step 9 calls this
# with no flags.
#
# Usage:
#   ./scripts/postinstall-verify.sh                  # default checks: no tokens, no credential resolved
#   ./scripts/postinstall-verify.sh --with-model                    [tokens] one live round trip
#   ./scripts/postinstall-verify.sh --model <provider/id>   model for --with-model (default: $PI_VERIFY_MODEL)
#   ./scripts/postinstall-verify.sh --credentials     resolve every declared credential reference (REQ-PRV-12b)
#   ./scripts/postinstall-verify.sh --json            machine-readable, for CI
#
# Exit: 0 no FAILs, 1 at least one FAIL, 2 the harness itself could not run (bad args, no repo).
# WARN never fails the run. SKIP marks an opt-in check that was not requested.
#
# Why five checks are gated behind a file-existence probe before they ever call `pi`: EXT-10
# (`extensions/doctor.ts`, the `/doctor` command) is scheduled for W3c, not W1 — this script ships
# before it exists, and a fork may never add it. PI does not intercept an unrecognised "/command"
# locally: verified by hand, a bare `-p '/doctor --json'` with no `doctor` command registered is
# forwarded to the configured model like any other message, spending real tokens on a request
# nobody asked for. So every doctor-backed check here checks for `extensions/doctor.ts` on disk
# FIRST and only calls `pi` once that file is confirmed present. Before EXT-10 lands, checks 5, 7
# and 8 report a clean, expected FAIL naming exactly that — never a silent skip, never a token spend.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck source=lib/portable-timeout.sh
. "$SCRIPT_DIR/lib/portable-timeout.sh"

# Same prefix contract as install.sh: every path hangs off $PREFIX so a throwaway test install
# ($PI_INSTALL_PREFIX=/some/tmp/dir) can be verified without touching the real one. install.sh
# exports PI_INSTALL_PREFIX when it calls this script, so the two always agree.
PREFIX="${PI_INSTALL_PREFIX:-$HOME}"
STABLE_LINK="$PREFIX/pi-config"
# $PI_CODING_AGENT_DIR is honoured ONLY for a normal install into $HOME — the same rule install.sh
# applies, and for the same measured reason: with --prefix the point is isolation, and an exported
# PI_CODING_AGENT_DIR left over from the operator's real shell makes this script verify the real
# install while reporting on the throwaway one. It did exactly that once.
if [ "$PREFIX" = "$HOME" ]; then AGENT_DIR="${PI_CODING_AGENT_DIR:-$PREFIX/.pi/agent}"
else AGENT_DIR="$PREFIX/.pi/agent"; fi
LOCK="$REPO_DIR/config/pi-release.lock"
MODELS_JSON="$REPO_DIR/config/models.json"
INDEX_TS="$REPO_DIR/extensions/index.ts"
DOCTOR_TS="$REPO_DIR/extensions/doctor.ts"

# Under a non-default prefix the binary this install produced is the one to verify, not whatever
# `pi` an earlier install left earlier on PATH.
if [ "$PREFIX" != "$HOME" ] && [ -x "$PREFIX/bin/pi" ]; then
  PI_BIN="$PREFIX/bin/pi"
else
  PI_BIN="$(command -v pi 2>/dev/null || true)"
  [ -n "$PI_BIN" ] || PI_BIN="$PREFIX/bin/pi"
fi

WITH_MODEL=0
WITH_CREDENTIALS=0
AS_JSON=0
MODEL="${PI_VERIFY_MODEL:-}"

usage() { sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --with-model)  WITH_MODEL=1; shift ;;
    --model)       MODEL="${2:?--model needs an argument}"; shift 2 ;;
    --credentials) WITH_CREDENTIALS=1; shift ;;
    --json)        AS_JSON=1; shift ;;
    -h|--help)     usage ;;
    *) printf 'postinstall-verify: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$LOCK" ]; then
  printf 'postinstall-verify: %s not found — not inside a PiON clone\n' "$LOCK" >&2
  exit 2
fi
# `jq` is deliberately NOT a prerequisite of this script. It is frequently absent, and frequently
# un-installable, on a locked-down machine — while Node is already mandatory, because PI itself is
# a Node program. So every JSON read below goes through scripts/lib/json.mjs (see its header).
if ! command -v node >/dev/null 2>&1; then
  printf 'postinstall-verify: node not found on PATH — PI itself is a Node program and cannot run without it.\n' >&2
  printf '  Fix: install Node 18 or newer (nodejs.org, nvm, or your package manager), then re-run.\n' >&2
  exit 2
fi
JSON_MJS="$SCRIPT_DIR/lib/json.mjs"
if [ ! -f "$JSON_MJS" ]; then
  printf 'postinstall-verify: %s is missing — this clone is incomplete; re-clone the repository.\n' "$JSON_MJS" >&2
  exit 2
fi
# One wrapper, so a reader greps `json ` and finds every JSON read in the file.
json() { node "$JSON_MJS" "$@"; }

# Field separator for the record streams `json rows` produces. US (0x1f), not TAB: TAB is IFS
# whitespace, so `IFS=$'\t' read` collapses consecutive tabs and shifts every field after an empty
# one. US is not whitespace, so an empty field stays one field.
US="$(printf '\037')"

lock_field() { json get "$LOCK" "$1"; }

# ------------------------------------------------------------------------------------------ table
PASS=0; FAIL=0; WARN=0; SKIP=0
declare -a NAMES=() STATUSES=() DETAILS=()

record() {
  NAMES+=("$1"); STATUSES+=("$2"); DETAILS+=("${3:-}")
  case "$2" in PASS) PASS=$((PASS + 1)) ;; FAIL) FAIL=$((FAIL + 1)) ;;
               WARN) WARN=$((WARN + 1)) ;; SKIP) SKIP=$((SKIP + 1)) ;; esac
}

# check <name> <fn> [args...]     FAIL on non-zero exit — used for hard requirements.
check() {
  local name="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then record "$name" PASS "$out"
  else record "$name" FAIL "$(printf '%s' "$out" | tail -1)"; fi
}
# warn_check <name> <fn> [args...]     WARN on non-zero exit — used for degradations that never
# block the run (provider reachability, system tool presence).
warn_check() {
  local name="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then record "$name" PASS "$out"
  else record "$name" WARN "$(printf '%s' "$out" | tail -1)"; fi
}
skip() { record "$1" SKIP "${2:-}"; }

# ------------------------------------------------------------------------------------- check 1
assert_pi_version() {
  [ -x "$PI_BIN" ] || { echo "pi not found at $PI_BIN — run ./scripts/install.sh"; return 1; }
  local want got
  want="$(lock_field '.version')"
  got="$(PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 "$PI_BIN" --version 2>/dev/null | tr -d 'v \r\n')"
  if [ "$got" = "$want" ]; then echo "$got at $PI_BIN"; return 0; fi
  echo "pi reports '$got', config/pi-release.lock pins '$want' — an older pi is earlier on PATH: type -a pi"
  return 1
}

# ------------------------------------------------------------------------------------- check 2
# The `required` symlinks install.sh creates, in the same required/optional split the installer
# itself uses — the two lists must not drift, or a correct install fails this check.
# `extensions` is NOT one of them and never was: its deliberate absence is asserted by check 2b.
REQUIRED_LINKS=(settings.json models.json routing.json prompts AGENTS.md)
# Present in this repo but not in every fork. `skills` in particular is optional by design: a fork
# may legitimately ship none, settings.json still lists the search path, and PI reads a missing
# search path as "no skills here". Each is asserted only when the repo actually contains it.
OPTIONAL_LINKS=(skills:skills web.json:config/web.json web-search.json:config/web-search.json hooks.yaml:config/hooks.yaml)
assert_symlinks() {
  local bad=() checked=0 name target entry src
  for name in "${REQUIRED_LINKS[@]}"; do
    checked=$((checked + 1))
    target="$(readlink "$AGENT_DIR/$name" 2>/dev/null || true)"
    case "$target" in "$STABLE_LINK"/*) : ;; *) bad+=("$name") ;; esac
  done
  for entry in "${OPTIONAL_LINKS[@]}"; do
    name="${entry%%:*}"; src="${entry#*:}"
    [ -e "$REPO_DIR/$src" ] || continue   # not shipped by this fork — nothing to link, nothing to check
    checked=$((checked + 1))
    target="$(readlink "$AGENT_DIR/$name" 2>/dev/null || true)"
    case "$target" in "$STABLE_LINK"/*) : ;; *) bad+=("$name") ;; esac
  done
  if [ "${#bad[@]}" -eq 0 ]; then
    echo "${checked}/${checked} resolve into $STABLE_LINK"; return 0
  fi
  echo "not a symlink into $STABLE_LINK: ${bad[*]} — re-run ./scripts/install.sh"
  return 1
}

# ------------------------------------------------------------------------------------ check 2b
# The inverse invariant. If `extensions` ever appears under $AGENT_DIR, PI's
# discoverExtensionsInDir loads every `extensions/*.ts` as a separate extension in readdir order,
# which breaks the fixed ORDER in extensions/index.ts (guard must precede bash) and fails each
# module that has no default export. settings.json names the composition root explicitly instead.
assert_extensions_not_linked() {
  if [ ! -e "$AGENT_DIR/extensions" ] && [ ! -L "$AGENT_DIR/extensions" ]; then
    echo "absent by design — settings.json names ~/pi-config/extensions/index.ts directly"; return 0
  fi
  echo "$AGENT_DIR/extensions exists — PI would load all 25 modules in readdir order, breaking ORDER; remove it"
  return 1
}

# ------------------------------------------------------------------------------------- check 3
assert_state_not_symlinked() {
  local bad=()
  for name in auth.json trust.json sessions; do
    [ -L "$AGENT_DIR/$name" ] && bad+=("$name")
  done
  if [ "${#bad[@]}" -eq 0 ]; then echo "auth.json, trust.json, sessions/ are real (PI-owned)"; return 0; fi
  echo "symlink into the repo: ${bad[*]} — PI-INSTALL-E19, credential-in-git guard tripped"
  return 1
}

# ------------------------------------------------------------------------------------- check 4
assert_pi_check() {
  [ -x "$REPO_DIR/bin/pi-check" ] || { echo "bin/pi-check not present (EXT-04a not built)"; return 1; }
  ( cd "$REPO_DIR" && run_with_timeout 30 "$REPO_DIR/bin/pi-check" --all )
}

# ---------------------------------------------------------------------------- doctor gate (5,7,8)
# One live call, cached, shared by the three checks that read /doctor's report — see the file
# header for why this is gated on extensions/doctor.ts existing before it ever runs `pi`.
DOCTOR_RAW=""
DOCTOR_FETCHED=0
DOCTOR_FETCH_ERR=""

fetch_doctor() {
  [ "$DOCTOR_FETCHED" -eq 1 ] && { [ -n "$DOCTOR_RAW" ]; return $?; }
  DOCTOR_FETCHED=1
  if [ ! -f "$INDEX_TS" ]; then
    DOCTOR_FETCH_ERR="extensions/index.ts not present — no extension composition root is wired yet"
    return 1
  fi
  if [ ! -f "$DOCTOR_TS" ]; then
    DOCTOR_FETCH_ERR="extensions/doctor.ts not present — EXT-10 is scheduled for W3c, not built yet"
    return 1
  fi
  if [ ! -x "$PI_BIN" ]; then
    DOCTOR_FETCH_ERR="pi not found at $PI_BIN"
    return 1
  fi
  local out
  if ! out="$(run_with_timeout 30 env PI_OFFLINE=1 "$PI_BIN" --mode json --no-session -p '/doctor --json' 2>&1)"; then
    DOCTOR_FETCH_ERR="pi /doctor invocation failed: $(printf '%s' "$out" | tail -1)"
    return 1
  fi
  DOCTOR_RAW="$out"
  return 0
}

# Reads one field out of the doctor report buried in `--mode json` output. The report's schema is
# EXT-10's to define and has changed once already, so the matcher (in json.mjs, subcommand
# `doctor-field`) stays forward-compatible: it takes several candidate paths and prints the first
# that resolves, at the top level or under a `.data` envelope. Array values come back comma-joined.
doctor_field() { printf '%s\n' "$DOCTOR_RAW" | json doctor-field "$@" 2>/dev/null; }

# Length of a comma-joined list from doctor_field. Empty string is 0, not 1 — which is why this is
# not `awk -F, '{print NF}'`.
count_csv() {
  [ -n "${1:-}" ] || { echo 0; return 0; }
  printf '%s' "$1" | tr ',' '\n' | grep -c . || true
}

# ------------------------------------------------------------------------------------- check 5
assert_doctor_modules() {
  fetch_doctor || { echo "$DOCTOR_FETCH_ERR"; return 1; }
  local loaded_csv declared_csv
  loaded_csv="$(doctor_field modules.loaded)"
  declared_csv="$(doctor_field modules.declared)"
  if [ -z "$loaded_csv" ] && [ -z "$declared_csv" ]; then
    echo "/doctor ran but produced no recognisable report"; return 1
  fi
  local loaded declared
  loaded="$(count_csv "$loaded_csv")"
  declared="$(count_csv "$declared_csv")"
  if [ "$loaded" = "$declared" ] && [ "$declared" -ge 1 ]; then
    local pkg_res pkg_dec pkgs=""
    pkg_res="$(doctor_field packages.resolved)"
    pkg_dec="$(doctor_field packages.declared)"
    if [ -n "$pkg_dec" ]; then pkgs="$(count_csv "$pkg_res")/$(count_csv "$pkg_dec") packages"; fi
    echo "modules ${loaded}/${declared} loaded${pkgs:+; $pkgs}"
    return 0
  fi
  # The set difference jq used to do, done in bash so this file keeps its one JSON dependency.
  local missing="" name
  for name in $(printf '%s' "$declared_csv" | tr ',' ' '); do
    case ",$loaded_csv," in *",$name,"*) : ;; *) missing="${missing:+$missing,}$name" ;; esac
  done
  echo "modules ${loaded}/${declared} loaded${missing:+; missing: $missing}"
  return 1
}

# ------------------------------------------------------------------------------------- check 6
assert_guard_blocks() {
  if [ ! -f "$REPO_DIR/extensions/guard.ts" ]; then echo "extensions/guard.ts not present"; return 1; fi
  if ! command -v node >/dev/null 2>&1; then echo "node not on PATH — cannot run the guard probe"; return 1; fi
  run_with_timeout 20 node "$SCRIPT_DIR/lib/guard-probe.mjs"
}

# ------------------------------------------------------------------------------------- check 7
assert_skills_discovered() {
  fetch_doctor || { echo "$DOCTOR_FETCH_ERR"; return 1; }
  # Two report shapes: `skills` as an object carrying a count, or `skills` as a plain array. Asking
  # for the count first keeps the array branch from having to guess whether "3" is a name or a size.
  local count; count="$(doctor_field skills.count)"
  if [ -z "$count" ]; then count="$(count_csv "$(doctor_field skills)")"; fi
  case "$count" in
    ''|*[!0-9]*) echo "/doctor ran but reported no skills field — check settings.json.skills paths"; return 1 ;;
  esac
  if [ "$count" -ge 1 ]; then echo "skills.count=$count"; return 0; fi
  echo "skills.count=0 — check settings.json.skills paths"
  return 1
}

# ------------------------------------------------------------------------------------- check 8
assert_tools_registered() {
  fetch_doctor || { echo "$DOCTOR_FETCH_ERR"; return 1; }
  # `tools` in the report is an object, `{count, names}`, in the current shape and a bare array in
  # the older one; elements are either plain strings or `{name}` objects. json.mjs's doctor-field
  # normalises all four combinations to a comma-joined list of names, which is the only thing this
  # check ever wanted.
  local names; names="$(doctor_field tools.names tools)"
  [ -n "$names" ] || { echo "/doctor ran but reported no tools — extensions did not register any"; return 1; }
  # Measured against a live `/doctor` on 2026-08-11: pi-web-access@0.18.0 registers `web_search`,
  # `source_check`, `web_fetch` and `get_search_content`. There is no `fetch_content`. A previous
  # edit asserted the opposite in a comment and changed the check to match the comment, which made
  # this assertion fail against a correct install. The measurement above is the authority here,
  # not the comment: re-measure with `/doctor --json` before changing either.
  local missing=()
  for want in web_search web_fetch; do
    case ",$names," in *",$want,"*) : ;; *) missing+=("$want") ;; esac
  done
  if [ "${#missing[@]}" -eq 0 ]; then
    echo "web_search, web_fetch present in getAllTools()"; return 0
  fi
  echo "missing: ${missing[*]} (doctor tools=${names:-<none>}) — EXT-07 failed to register"
  return 1
}

# ------------------------------------------------------------------------------------- check 9
# Local-only: never a network call, never resolves a secret *value*, only asks whether the thing
# each provider says it needs is present. WARN-only by construction — an unavailable provider is a
# normal machine state, not a broken install.
#
# There is deliberately no hardcoded table of providers here. The old one drifted from reality
# twice (it probed an env var that existed nowhere, and it named providers a fork does not have),
# so the probe is now derived from two files that a fork edits anyway:
#
#   config/providers/<id>.json   `requires[]` — each entry is {kind, name, required}
#   config/models.json           `providers.<id>.apiKey` — the "$VAR" / "!command" reference
#
# Add a provider fragment and it is probed; delete one and it stops being probed. Only entries
# marked `required: true` gate availability, matching config/providers/README.md §2.1: a missing
# *optional* requirement is a warning, never a verdict.
probe_provider() { # probe_provider <id> -> 0 available, 1 with a reason on stdout
  local p="$1"
  # Two statements, not one `local p=... frag=...`: within a single `local`, whether $p is
  # already visible to the next assignment is shell-dependent (SC2318).
  local frag="$REPO_DIR/config/providers/$p.json"
  # Named `lack`, not `missing`: two other functions in this file use `missing` as an array,
  # and a reader (and shellcheck) should not have to work out that these are unrelated locals.
  local lack="" kind name required ref checked=0

  if [ -f "$frag" ]; then
    while IFS="$US" read -r kind name required; do
      [ -n "$kind" ] || continue
      [ "$required" = "true" ] || continue
      # README §2.8: a requirement's variable NAME may be deferred to an install-time answer, in
      # which case the fragment holds a lone {{token}} and not a name. Probing that literally
      # reports "needs ${{apiKeyEnv}}", which names nothing the operator can export. The answer
      # landed in the generated models.json, as providers.<id>.apiKey = "$THE_NAME".
      case "$name" in
        '{{'*'}}')
          ref="$(json get "$MODELS_JSON" "providers.$p.apiKey" 2>/dev/null || true)"
          case "$ref" in
            '$'*) name="${ref#\$}" ;;
            *)    continue ;;   # unresolvable: declared-but-unprobed, not a failure
          esac ;;
      esac
      checked=$((checked + 1))
      case "$kind" in
        env)
          # Indirect expansion, bash 3.2-safe. The value is never printed — only its name.
          [ -n "${!name:-}" ] || lack="${lack:+$lack, }\$$name" ;;
        command)
          command -v "$name" >/dev/null 2>&1 || lack="${lack:+$lack, }$name(1)" ;;
        service)
          # A service is only observable by connecting to it, and this check does not make network
          # calls. Counted as declared-but-unprobed rather than silently assumed present.
          checked=$((checked - 1)) ;;
      esac
    done < <(json rows "$frag" requires kind name required 2>/dev/null)
  fi

  # No fragment, or a fragment with nothing required: fall back to whatever credential reference
  # the generated models.json actually names for this provider.
  if [ "$checked" -eq 0 ]; then
    local ref; ref="$(json get "$MODELS_JSON" "providers.$p.apiKey" 2>/dev/null || true)"
    case "$ref" in
      '$'*) name="${ref#\$}"; [ -n "${!name:-}" ] || lack="\$$name" ;;
      '!'*) name="${ref#!}"; name="${name%% *}"
            command -v "$name" >/dev/null 2>&1 || lack="$name(1)" ;;
      *)    : ;;   # a literal key, or none needed — nothing local to probe
    esac
  fi

  [ -z "$lack" ] || { printf '%s needs %s' "$p" "$lack"; return 1; }
  return 0
}

warn_provider_reachability() {
  [ -f "$MODELS_JSON" ] || { echo "config/models.json not found — run ./scripts/install.sh"; return 1; }
  local providers; providers="$(json keys "$MODELS_JSON" providers 2>/dev/null || true)"
  [ -n "$providers" ] || { echo "no providers declared in config/models.json"; return 1; }
  local avail=() unavail=() p reason
  # The reasons are joined by "; " rather than left to "${unavail[*]}", whose separator is a space
  # — and each reason already contains spaces, so the list would read as one run-on sentence.
  local reasons=""
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    if reason="$(probe_provider "$p")"; then
      avail+=("$p")
    else
      unavail+=("$p"); reasons="${reasons:+$reasons; }$reason"
    fi
  done <<< "$providers"
  local total=$(( ${#avail[@]} + ${#unavail[@]} ))
  echo "${#avail[@]}/${total} available${avail[*]:+ (${avail[*]})}${reasons:+ — $reasons}"
  [ "${#avail[@]}" -gt 0 ]
}

# ------------------------------------------------------------------------------------ check 10
assert_fd_rg_present() {
  local have_fd=0 have_rg=0
  command -v fd >/dev/null 2>&1 || command -v fdfind >/dev/null 2>&1 && have_fd=1
  command -v rg >/dev/null 2>&1 && have_rg=1
  if [ "$have_fd" = 1 ] && [ "$have_rg" = 1 ]; then echo "fd and rg on PATH"; return 0; fi
  echo "fd=$have_fd rg=$have_rg — install via your package manager, PI degrades to slower built-ins"
  return 1
}

# ------------------------------------------------------------------------------------ check 11
assert_tls_proxy_env() {
  if [ -z "${NODE_EXTRA_CA_CERTS:-}" ]; then
    echo "NODE_EXTRA_CA_CERTS not set — fine outside a corporate MITM network"; return 0
  fi
  if [ ! -r "$NODE_EXTRA_CA_CERTS" ]; then
    echo "NODE_EXTRA_CA_CERTS='$NODE_EXTRA_CA_CERTS' is set but not readable"; return 1
  fi
  local np="${NO_PROXY:-${no_proxy:-}}"
  if [ -n "${HTTPS_PROXY:-${https_proxy:-}}" ]; then
    # REQ-PRV-60 / task brief: NO_PROXY must cover all three loopback spellings, or the local
    # lane (llama-swap, MCP loopback servers) gets routed through the corporate proxy and breaks.
    local missing=() tok
    for tok in 127.0.0.1 localhost ::1; do
      case "$np" in *"$tok"*) : ;; *) missing+=("$tok") ;; esac
    done
    if [ "${#missing[@]}" -gt 0 ]; then
      echo "NODE_EXTRA_CA_CERTS readable, but NO_PROXY='$np' misses: ${missing[*]}"; return 1
    fi
  fi
  echo "NODE_EXTRA_CA_CERTS readable ($NODE_EXTRA_CA_CERTS) — V-14: unverified on the binary path"
  return 0
}

# ------------------------------------------------------------------------------------ check 12
assert_model_round_trip() {
  [ -n "$MODEL" ] || { echo "no --model given (and \$PI_VERIFY_MODEL unset)"; return 1; }
  [ -x "$PI_BIN" ] || { echo "pi not found at $PI_BIN"; return 1; }
  local out
  out="$(run_with_timeout 60 "$PI_BIN" -p 'reply with the single word OK' --model "$MODEL" 2>&1)"
  local status=$?
  if [ "$status" -eq 0 ] && printf '%s' "$out" | grep -qi '\bok\b'; then
    echo "model=$MODEL replied"; return 0
  fi
  echo "model=$MODEL exit=$status — $(printf '%s' "$out" | tail -1)"
  return 1
}

# ------------------------------------------------------------------------------------ check 13
# REQ-PRV-12b: resolves every declared `$ENV` / `!command` apiKey reference in config/models.json.
# Prints the provider + reference NAME on failure, never the resolved value.
assert_credentials_resolve() {
  [ -f "$MODELS_JSON" ] || { echo "config/models.json not found"; return 1; }
  local refs; refs="$(json apikey-refs "$MODELS_JSON" 2>/dev/null || true)"
  [ -n "$refs" ] || { echo "no \$ENV / !command apiKey references declared"; return 0; }
  local unresolved=() n=0
  local provider ref
  while IFS=$'\t' read -r provider ref; do
    n=$((n + 1))
    case "$ref" in
      '$'*)
        local var="${ref#\$}"
        [ -n "${!var:-}" ] || unresolved+=("$provider:\$$var")
        ;;
      '!'*)
        local cmd="${ref#!}"
        local expanded; expanded="$(eval "printf '%s' \"$cmd\"" 2>/dev/null)"
        if ! run_with_timeout 15 bash -c "$expanded" >/dev/null 2>&1; then
          unresolved+=("$provider:!$cmd")
        fi
        ;;
    esac
  done <<< "$refs"
  if [ "${#unresolved[@]}" -eq 0 ]; then echo "$n reference(s) resolved"; return 0; fi
  echo "unresolved: ${unresolved[*]}"
  return 1
}

# ------------------------------------------------------------------------------------------- run
check      "pi version pinned"        assert_pi_version
check      "config symlinks resolved" assert_symlinks
check      "extensions not linked"    assert_extensions_not_linked
check      "state not in git"         assert_state_not_symlinked
check      "pi-check --all"           assert_pi_check
check      "extensions loaded"        assert_doctor_modules
check      "guardrail blocks rm -rf"  assert_guard_blocks
check      "skills discovered"        assert_skills_discovered
check      "tools registered"         assert_tools_registered
warn_check "provider credentials"     warn_provider_reachability
warn_check "fd / rg present"          assert_fd_rg_present
check      "TLS/proxy env"            assert_tls_proxy_env

if [ "$WITH_MODEL" = 1 ]; then check "model round trip" assert_model_round_trip
else skip "model round trip" "run with --with-model --model <provider/id>"; fi

if [ "$WITH_CREDENTIALS" = 1 ]; then check "credentials resolve" assert_credentials_resolve
else skip "credentials resolve" "run with --credentials (REQ-PRV-12b, opt-in only)"; fi

# ---------------------------------------------------------------------------------------- output
if [ "$AS_JSON" = 1 ]; then
  printf '{"results":['
  for i in "${!NAMES[@]}"; do
    [ "$i" -gt 0 ] && printf ','
    printf '{"name":%s,"status":%s,"detail":%s}' \
      "$(json string "${NAMES[$i]}")" "$(json string "${STATUSES[$i]}")" \
      "$(json string "${DETAILS[$i]}")"
  done
  printf '],"summary":{"pass":%d,"fail":%d,"warn":%d,"skip":%d}}\n' "$PASS" "$FAIL" "$WARN" "$SKIP"
else
  if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; B=$'\033[2m'; Z=$'\033[0m'
  else G=""; R=""; Y=""; B=""; Z=""; fi
  for i in "${!NAMES[@]}"; do
    case "${STATUSES[$i]}" in PASS) C="$G" ;; FAIL) C="$R" ;; WARN) C="$Y" ;; *) C="$B" ;; esac
    printf '  %s%-6s%s %-26s %s\n' "$C" "${STATUSES[$i]}" "$Z" "${NAMES[$i]}" "${DETAILS[$i]}"
  done
  printf '\n%d passed, %d failed, %d warning(s), %d skipped\n' "$PASS" "$FAIL" "$WARN" "$SKIP"
fi

[ "$FAIL" -eq 0 ] || exit 1
exit 0
