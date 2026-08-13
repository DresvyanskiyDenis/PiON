#!/usr/bin/env bash
# verify-environment.sh — pre-install environment probe. Answers "does this machine have what PI
# needs", before ./scripts/install.sh is run. The post-install counterpart is
# scripts/postinstall-verify.sh.
#
# PiON — a hardened, portable harness for the PI coding agent.
#   https://dresvyanskiydenis.github.io/PiON/operations/verification/
#
# Runs every verification item from docs/operations/verification.md that does NOT need a human
# in a TUI, and prints one PASS/FAIL/WARN/SKIP/MANUAL table.
#
#   ./scripts/verify-environment.sh                       # cheap checks only, no tokens spent
#   ./scripts/verify-environment.sh --with-model          # + checks that make real model calls
#   ./scripts/verify-environment.sh --with-slow           # + the 62-minute bash-timeout ceiling probe
#   ./scripts/verify-environment.sh --gho gho_xxx         # + Copilot endpoint probes (V-12 step 5, V-13)
#   ./scripts/verify-environment.sh --gho-from-auth       # read the gho_ from ~/.pi/agent/auth.json
#
# Options:
#   --model <provider/id>   model used by --with-model checks (default: $PI_VERIFY_MODEL)
#   --local-model <p/id>    a model served by your local OpenAI-compatible server, for the offline check
#   --ca <path>             CA bundle for the NODE_EXTRA_CA_CERTS check (TLS-inspecting networks)
#   --ghe <domain>          GitHub Enterprise domain to probe, e.g. <tenant>.ghe.com (default: none)
#   --workdir <path>        scratch dir (default: $TMPDIR/pi-env-verify)
#   --json                  emit machine-readable JSON instead of the table
#
# Exit code: 0 = no FAILs, 1 = at least one FAIL, 2 = the harness itself could not run.
# Nothing here writes to ~/.pi/agent. Every probe uses an isolated PI_CODING_AGENT_DIR.
# `jq` is deliberately NOT required: every JSON read goes through scripts/lib/json.mjs, on the
# Node runtime PI itself already depends on.

set -uo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
JSON_MJS="$SCRIPT_DIR/lib/json.mjs"
if ! command -v node >/dev/null 2>&1; then
  echo "FATAL: node is not on PATH. PI is a Node program; install Node 18+ and re-run." >&2
  exit 2
fi
if [ ! -f "$JSON_MJS" ]; then
  echo "FATAL: $JSON_MJS is missing — this clone is incomplete; re-clone the repository." >&2
  exit 2
fi
# One wrapper, so a reader greps `json ` and finds every JSON read in the file.
json() { node "$JSON_MJS" "$@"; }

# Field separator for `json rows` output. US (0x1f), not TAB: TAB is IFS whitespace, so an empty
# field silently merges with its neighbour and every later field shifts left by one.
US="$(printf '\037')"

# ---------------------------------------------------------------------------- args
WITH_MODEL=0; WITH_SLOW=0; AS_JSON=0
# No GitHub Enterprise host is assumed. The Copilot probes fall back to api.github.com alone
# unless you name your tenant with --ghe <tenant>.ghe.com — there is no sensible default here,
# and guessing one produced a confusing DNS failure rather than a clean SKIP.
GHO="${GHO:-}"; GHE_DOMAIN="${PI_VERIFY_GHE_DOMAIN:-}"
MODEL="${PI_VERIFY_MODEL:-}"; LOCAL_MODEL="${PI_VERIFY_LOCAL_MODEL:-}"
CA_BUNDLE="${NODE_EXTRA_CA_CERTS:-}"
WORKDIR="${TMPDIR:-/tmp}/pi-env-verify"

while [ $# -gt 0 ]; do
  case "$1" in
    --with-model)    WITH_MODEL=1 ;;
    --with-slow)     WITH_SLOW=1 ;;
    --json)          AS_JSON=1 ;;
    --gho)           GHO="${2:-}"; shift ;;
    --gho-from-auth) GHO="$(json get "$HOME/.pi/agent/auth.json" 'github-copilot.refresh' 2>/dev/null || true)" ;;
    --ghe)           GHE_DOMAIN="${2:-}"; shift ;;
    --model)         MODEL="${2:-}"; shift ;;
    --local-model)   LOCAL_MODEL="${2:-}"; shift ;;
    --ca)            CA_BUNDLE="${2:-}"; shift ;;
    --workdir)       WORKDIR="${2:-}"; shift ;;
    -h|--help)       sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

mkdir -p "$WORKDIR" || { echo "cannot create workdir $WORKDIR" >&2; exit 2; }
LOG="$WORKDIR/raw"; mkdir -p "$LOG"

# ---------------------------------------------------------------------------- table
IDS=(); STATUSES=(); TITLES=(); DETAILS=()
record() { IDS+=("$1"); STATUSES+=("$2"); TITLES+=("$3"); DETAILS+=("${4:-}"); }
have()   { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------- prerequisites
if ! have pi; then
  echo "FATAL: 'pi' is not on PATH. Install it first: ./scripts/install.sh" >&2
  echo "       docs/getting-started/prerequisites.md — https://dresvyanskiydenis.github.io/PiON/getting-started/prerequisites/" >&2
  exit 2
fi
PI_VERSION="$(pi --version 2>/dev/null | head -1 | tr -d '\r')"
record PRE-01 "$( [ -n "$PI_VERSION" ] && echo PASS || echo FAIL )" \
       "pi binary present" "version=${PI_VERSION:-unknown}"

# `jq` is NOT in this list on purpose — see the file header. `curl` and `git` are, because several
# probes below shell out to them and there is no in-tree substitute.
for t in curl git; do
  if have "$t"; then record "PRE-$t" PASS "$t available" ""
  else record "PRE-$t" FAIL "$t available" "install it; several checks depend on it"; fi
done
if have jq; then record PRE-jq PASS "jq available" "not required — nothing here depends on it"
else record PRE-jq SKIP "jq available" "absent, and that is fine: JSON is read through scripts/lib/json.mjs"; fi

# Neither `timeout` nor `gtimeout` is guaranteed present (stock macOS ships neither, and this
# machine has neither — confirmed by hand). A hung probe must never hang the whole run, so `TO`
# is backed by the pure-bash bound in lib/portable-timeout.sh instead of shelling out to either
# binary: no external dependency, and every probe stays bounded regardless of what the machine
# has installed. `run_with_timeout` normalises a real timeout to exit 124, matching GNU
# `timeout`'s convention — several checks below (V-01, V-08) test for exactly that code.
# shellcheck source=lib/portable-timeout.sh
. "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/lib/portable-timeout.sh"
TO() { run_with_timeout "$@"; }
record PRE-timeout PASS "timeout available" "pure-bash bound (scripts/lib/portable-timeout.sh) — no timeout/gtimeout binary required"

if have node; then
  NODE_V="$(node --version 2>/dev/null | tr -d 'v')"
  NODE_MAJOR="${NODE_V%%.*}"
  if [ "${NODE_MAJOR:-0}" -ge 22 ] 2>/dev/null; then
    record PRE-node PASS "node >= 22.19.0 (npm fallback path viable)" "node=$NODE_V"
  else
    record PRE-node WARN "node >= 22.19.0" "node=$NODE_V — npm install path (REQ-PRV-62) needs mise/fnm"
  fi
else
  record PRE-node WARN "node present" "absent — fine for the standalone binary, blocks the npm fallback"
fi

# 09 §5.4 gotcha 1: fd/rg auto-download from GitHub releases on first use of find/grep
FDRG=""
have fd || have fdfind || FDRG="fd missing "
have rg || FDRG="${FDRG}rg missing"
if [ -z "$FDRG" ]; then
  record PRE-fdrg PASS "system fd + ripgrep present" "PI prefers system binaries; no GitHub release download"
else
  record PRE-fdrg WARN "system fd + ripgrep present" "$FDRG — PI will try to download from GitHub releases unless PI_OFFLINE=1"
fi

# ---------------------------------------------------------------------------- probe package
PKG="$WORKDIR/pkg"; DIR_A="$WORKDIR/dir-a"
mkdir -p "$PKG/extensions" "$PKG/skills/probe-skill" "$DIR_A"

cat > "$PKG/extensions/introspect.ts" <<'TS'
export default function (pi: any) {
  pi.on("session_start", () => {
    try {
      const tools = pi.getAllTools ? pi.getAllTools() : [];
      const cmds = pi.getCommands ? pi.getCommands() : [];
      const payload = {
        toolCount: tools.length,
        toolBytes: tools.reduce((n: number, t: any) => n + JSON.stringify(t).length, 0),
        toolNames: tools.map((t: any) => t.name).sort(),
        skills: cmds.filter((c: any) => c.source === "skill")
                    .map((c: any) => ({ name: c.name, baseDir: c?.sourceInfo?.baseDir ?? null })),
      };
      console.error("PIPROBE=" + JSON.stringify(payload));
    } catch (e) { console.error("PIPROBE_ERROR=" + String(e)); }
  });
  if (process.env.PROBE_DISCOVER === "1") {
    pi.on("resources_discover", () => ({
      skills: [{ name: "probe-injected", description: "resources_discover probe" }],
    }));
  }
}
TS

cat > "$PKG/skills/probe-skill/SKILL.md" <<'MD'
---
name: probe-skill
description: exists only so the built-in skill scan has something to find
---
Probe skill body.
MD

printf '{"packages":["%s"],"defaultProjectTrust":"always"}\n' "$PKG" > "$DIR_A/settings.json"

# Runs a throwaway session and returns the PIPROBE json on stdout (empty if the probe did not load).
probe_json() {
  ( cd "$WORKDIR" || exit 1
    export PROBE_DISCOVER="${1:-0}" PI_CODING_AGENT_DIR="$DIR_A" PI_OFFLINE=1
    # </dev/null on every raw `pi -p` call below: with stdin open and no TTY, print mode merges
    # the (never-arriving) piped input into the prompt and blocks forever — see bin/pi-run's
    # header, fact 3. These calls stay UN-wrapped by bin/pi-run on purpose: they are the measuring
    # instruments for V-01/V-08/V-22/V-17, which probe pi's own exit code directly; routing them
    # through the wrapper would make them observe pi-run's verdict instead of pi's.
    TO 90 pi -p "reply with the single word ok" --mode json </dev/null
  ) 2> "$LOG/probe.err" >/dev/null
  grep -h '^PIPROBE=' "$LOG/probe.err" 2>/dev/null | tail -1 | cut -d= -f2-
}

PROBE_OUT="$(probe_json 0)"
if [ -n "$PROBE_OUT" ]; then
  # Written to disk first because json.mjs reads files, not stdin — and because the raw probe
  # output is exactly what a human wants when one of the V-checks below disagrees with them.
  echo "$PROBE_OUT" > "$LOG/probe-a.json"
  record PROBE PASS "local-path probe package loads" \
    "tools=$(json get "$LOG/probe-a.json" toolCount) bytes=$(json get "$LOG/probe-a.json" toolBytes)"
else
  record PROBE WARN "local-path probe package loads" \
    "no PIPROBE line — see $LOG/probe.err; try 'pi install $PKG' against PI_CODING_AGENT_DIR=$DIR_A. V-02/V-04/V-05 will SKIP."
fi

# ---------------------------------------------------------------------------- V-06
HELP="$(pi --help 2>&1)"; echo "$HELP" > "$LOG/help.txt"
if echo "$HELP" | grep -qiE '\-\-no-extensions|\-\-no-packages|\-\-disable-extensions'; then
  record V-06 PASS "CI profile: --no-extensions equivalent exists" \
    "$(echo "$HELP" | grep -oiE '\-\-(no-extensions|no-packages|disable-extensions)' | head -1)"
else
  record V-06 FAIL "CI profile: --no-extensions equivalent exists" \
    "no flag; REQ-EXT-43 fallback = isolated PI_CODING_AGENT_DIR with packages:[] (no extra days)"
fi

# ---------------------------------------------------------------------------- V-16
V16_HELP=0; V16_TOOL=0; V16_NAMES=""
echo "$HELP" | grep -qi 'ask_question' && V16_HELP=1
# jq's `select(test(...))` done with grep: json.mjs prints one tool name per line precisely so the
# filtering can stay in the shell instead of growing a query language.
if [ -n "$PROBE_OUT" ]; then
  V16_NAMES="$(json get "$LOG/probe-a.json" toolNames 2>/dev/null | grep -iE 'ask|question|elicit' | paste -sd, -)"
  [ -n "$V16_NAMES" ] && V16_TOOL=1
fi
if [ "$V16_TOOL" = 1 ]; then
  record V-16 PASS "ask_question in the default tool set" \
    "$V16_NAMES — still confirm the list renders interactively"
elif [ "$V16_HELP" = 1 ]; then
  record V-16 WARN "ask_question in the default tool set" "named in --help but not in getAllTools(); check interactively"
elif [ -z "$PROBE_OUT" ]; then
  record V-16 SKIP "ask_question in the default tool set" "probe package did not load"
else
  record V-16 FAIL "ask_question in the default tool set" "absent ⇒ ~60-line pi.registerTool over ctx.ui (+0.5 d, folds into EXT-12)"
fi

# ---------------------------------------------------------------------------- V-05
if [ -z "$PROBE_OUT" ]; then
  record V-05 SKIP "skill sourceInfo.baseDir populated" "probe package did not load"
else
  # "<name>US<baseDir>" per skill; the empty-field-safe separator matters here because baseDir
  # being empty is precisely the outcome under test.
  BASEDIR="$(json rows "$LOG/probe-a.json" skills name baseDir 2>/dev/null \
             | awk -F"$US" '$1 ~ /probe-skill/ { print ($2 == "" ? "null" : $2); exit }')"
  if [ -n "$BASEDIR" ] && [ "$BASEDIR" != "null" ]; then
    record V-05 PASS "skill sourceInfo.baseDir populated" "baseDir=$BASEDIR"
  elif [ "$BASEDIR" = "null" ]; then
    record V-05 FAIL "skill sourceInfo.baseDir populated" \
      "null ⇒ EXT-16 env shim (PI_SKILL_DIR) becomes MANDATORY: 8 of 20 skills ship executables (+0.5 d)"
  else
    record V-05 WARN "skill sourceInfo.baseDir populated" "probe-skill not discovered at all — check the skills/ layout first"
  fi
fi

# ---------------------------------------------------------------------------- V-04
if [ -z "$PROBE_OUT" ]; then
  record V-04 SKIP "resources_discover additive vs replacement" "probe package did not load"
else
  PROBE_B="$(probe_json 1)"
  if [ -z "$PROBE_B" ]; then
    record V-04 SKIP "resources_discover additive vs replacement" "second probe produced no output"
  else
    echo "$PROBE_B" > "$LOG/probe-b.json"
    B_NAMES="$(json rows "$LOG/probe-b.json" skills name 2>/dev/null)"
    HAS_BUILTIN=$(printf '%s\n' "$B_NAMES" | grep -c 'probe-skill'  || true)
    HAS_INJECT=$(printf  '%s\n' "$B_NAMES" | grep -c 'probe-injected' || true)
    if [ "${HAS_INJECT:-0}" -gt 0 ] && [ "${HAS_BUILTIN:-0}" -eq 0 ]; then
      record V-04 PASS "resources_discover replaces the built-in scan" "default-deny is structural (REQ-EXT-06 at S)"
    elif [ "${HAS_INJECT:-0}" -gt 0 ]; then
      record V-04 FAIL "resources_discover replaces the built-in scan" \
        "ADDITIVE ⇒ default-deny must be discovery-root layout + globs; constrains the repo directory layout"
    else
      record V-04 WARN "resources_discover fires at all" "handler produced no visible skill — event may not exist as documented"
    fi
  fi
fi

# ---------------------------------------------------------------------------- V-01
V01_DIR="$WORKDIR/v01"; mkdir -p "$V01_DIR"
cat > "$V01_DIR/models.json" <<'JSON'
{ "providers": { "broken": {
    "name": "Deliberately broken",
    "baseUrl": "https://gateway.invalid.example/v1",
    "api": "openai-completions",
    "apiKey": "$PI_FAKE_KEY",
    "models": [ { "id": "probe-model", "contextWindow": 128000, "maxTokens": 4096 } ] } } }
JSON
printf '{"defaultProjectTrust":"always"}\n' > "$V01_DIR/settings.json"
PI_FAKE_KEY=definitely-not-a-key PI_CODING_AGENT_DIR="$V01_DIR" PI_OFFLINE=1 \
  TO 90 pi -p "hi" --model broken/probe-model </dev/null > "$LOG/v01.out" 2> "$LOG/v01.err"
V01_EXIT=$?
if [ "$V01_EXIT" -eq 127 ]; then
  record V-01 WARN "pi -p exits non-zero on provider failure" "exit=127 — harness could not launch pi; not a result"
elif [ "$V01_EXIT" -eq 124 ]; then
  record V-01 WARN "pi -p exits non-zero on provider failure" "the run hung and was killed at 90 s — investigate by hand"
elif [ "$V01_EXIT" -ne 0 ]; then
  record V-01 PASS "pi -p exits non-zero on provider failure" "exit=$V01_EXIT — bin/pi-run stays thin"
else
  record V-01 FAIL "pi -p exits non-zero on provider failure" \
    "exit=0 ⇒ every headless caller must parse --mode json in bin/pi-run (+0.5 d to EXT-01); BLOCKER for W1"
fi

# ---------------------------------------------------------------------------- V-22
MS="$HOME/.pi/agent/models-store.json"
MS_BEFORE=""; [ -f "$MS" ] && MS_BEFORE="$(date -r "$MS" +%s 2>/dev/null)"
PI_OFFLINE=1 TO 30 pi --version >/dev/null 2>&1; V22_EXIT=$?
MS_AFTER=""; [ -f "$MS" ] && MS_AFTER="$(date -r "$MS" +%s 2>/dev/null)"
if [ "$V22_EXIT" -eq 127 ]; then
  record V-22 WARN "PI_OFFLINE=1 startup is clean" "exit=127 — harness could not launch pi; not a result"
elif [ "$V22_EXIT" -ne 0 ]; then
  record V-22 FAIL "PI_OFFLINE=1 startup is clean" "pi --version exited $V22_EXIT under PI_OFFLINE=1"
elif [ "$MS_BEFORE" != "$MS_AFTER" ]; then
  record V-22 FAIL "no model-catalogue refresh under PI_OFFLINE=1" \
    "models-store.json mtime changed ⇒ rebuild with --offline-model-data or ship a seeded store"
else
  record V-22 PASS "PI_OFFLINE=1 startup is clean" "no catalogue refresh; confirm with the network down for the full answer"
fi

# ---------------------------------------------------------------------------- V-15 (env sanity only)
if [ -n "${HTTPS_PROXY:-}${https_proxy:-}" ]; then
  if echo "${NO_PROXY:-}${no_proxy:-}" | grep -q '127\.0\.0\.1' && echo "${NO_PROXY:-}${no_proxy:-}" | grep -q 'localhost'; then
    record V-15 PASS "NO_PROXY covers 127.0.0.1 + localhost" "REQ-PRV-60: llama-swap traffic stays on the machine"
  else
    record V-15 FAIL "NO_PROXY covers 127.0.0.1 + localhost" \
      "proxy is set but NO_PROXY='${NO_PROXY:-${no_proxy:-<unset>}}' — local model traffic would traverse the corporate proxy"
  fi
else
  record V-15 SKIP "proxy surfaces" "no HTTPS_PROXY in this shell; run the four-surface check by hand on the corporate network"
fi

# ---------------------------------------------------------------------------- V-14
if [ -z "$CA_BUNDLE" ]; then
  record V-14 SKIP "standalone binary honours NODE_EXTRA_CA_CERTS" "pass --ca <path-to-corp-ca.pem>"
elif [ ! -f "$CA_BUNDLE" ]; then
  record V-14 FAIL "corporate CA bundle readable" "not a file: $CA_BUNDLE"
else
  if openssl x509 -in "$CA_BUNDLE" -noout -subject > "$LOG/ca.txt" 2>&1 || \
     openssl crl2pkcs7 -nocrl -certfile "$CA_BUNDLE" 2>/dev/null | openssl pkcs7 -print_certs -noout > "$LOG/ca.txt" 2>&1; then
    if [ "$WITH_MODEL" = 1 ] && [ -n "$MODEL" ]; then
      NODE_EXTRA_CA_CERTS="$CA_BUNDLE" TO 120 pi -p "reply with the single word ok" --model "$MODEL" \
        </dev/null > "$LOG/v14.out" 2> "$LOG/v14.err"
      if [ $? -eq 0 ] && grep -qi 'ok' "$LOG/v14.out"; then
        record V-14 PASS "binary honours NODE_EXTRA_CA_CERTS" "model call succeeded through the corporate TLS chain"
      else
        record V-14 FAIL "binary honours NODE_EXTRA_CA_CERTS" \
          "call failed with the CA set ⇒ fall back to npm + user-space Node (REQ-PRV-62, +1 d to EXT-28); try NODE_OPTIONS=--use-openssl-ca first. see $LOG/v14.err"
      fi
    else
      record V-14 WARN "binary honours NODE_EXTRA_CA_CERTS" "CA bundle parses; re-run with --with-model --model <provider/id> to prove it end-to-end"
    fi
  else
    record V-14 FAIL "corporate CA bundle parses" "openssl could not read $CA_BUNDLE"
  fi
fi

# ---------------------------------------------------------------------------- V-12 step 5 + V-13
if [ -z "$GHO" ]; then
  record V-12 SKIP "Copilot token endpoint (V-12 step 5)" "pass --gho gho_… or --gho-from-auth after completing the device flow"
  record V-13 SKIP "Copilot billing regime" "needs \$GHO"
else
  COP_HDRS=(-H "Authorization: token $GHO"
            -H 'User-Agent: GitHubCopilotChat/0.35.0'
            -H 'Editor-Version: vscode/1.107.0'
            -H 'Editor-Plugin-Version: copilot-chat/0.35.0'
            -H 'Copilot-Integration-Id: vscode-chat')
  # api.github.com always; a GitHub Enterprise host only when the operator named one. Probing
  # "api." with an empty domain resolves to nothing and reports as a mysterious 000.
  declare -a HOSTS=("api.github.com")
  [ -n "$GHE_DOMAIN" ] && HOSTS+=("api.$GHE_DOMAIN")
  V12_RESULT=""; V12_OK_HOST=""
  for H in "${HOSTS[@]}"; do
    CODE=$(curl -sS --max-time 20 -D "$LOG/$H.headers" -o "$LOG/$H.body" -w '%{http_code}' \
             "${COP_HDRS[@]}" "https://$H/copilot_internal/v2/token" 2>>"$LOG/curl.err")
    [ -z "$CODE" ] && CODE="000"
    V12_RESULT="$V12_RESULT $H=$CODE"
    [ "$CODE" = "200" ] && [ -z "$V12_OK_HOST" ] && V12_OK_HOST="$H"
  done
  SSO=$(grep -ih '^x-github-sso:' "$LOG"/*.headers 2>/dev/null | head -1)
  if [ -n "$V12_OK_HOST" ]; then
    PROXY_EP=$(json get "$LOG/$V12_OK_HOST.body" token 2>/dev/null | grep -o 'proxy-ep=[^;]*' | cut -d= -f2)
    record V-12 PASS "Copilot token endpoint answers" "200 from $V12_OK_HOST; proxy-ep=${PROXY_EP:-none};$V12_RESULT"
  elif [ -n "$SSO" ]; then
    record V-12 FAIL "Copilot token endpoint answers" \
      "403 + SAML SSO required — authorize the token at the URL in: $SSO — then re-run;$V12_RESULT"
  elif [ -n "$GHE_DOMAIN" ]; then
    # Disambiguator: does the Enterprise host exist at all? A 404 on /meta means the endpoint
    # itself is wrong (Copilot tokens are issued by api.github.com even for Enterprise seats);
    # /meta 200 with a 404 on the token path means the tenant's policy is refusing, not the URL.
    GHE_META=$(curl -sS --max-time 15 -o /dev/null -w '%{http_code}' "https://api.$GHE_DOMAIN/meta" 2>/dev/null)
    record V-12 FAIL "Copilot token endpoint answers" \
      "$V12_RESULT ; api.$GHE_DOMAIN/meta=$GHE_META. meta 404 ⇒ wrong endpoint, drop --ghe and use api.github.com. both 404 with meta 200 ⇒ tenant policy, not this harness"
  else
    record V-12 FAIL "Copilot token endpoint answers" \
      "$V12_RESULT — the token was rejected by api.github.com. Re-check the gho_ value; if your seat is on GitHub Enterprise, re-run with --ghe <tenant>.ghe.com"
  fi

  UCODE=$(curl -sS --max-time 20 -o "$LOG/copilot-user.json" -w '%{http_code}' \
            -H "Authorization: token $GHO" https://api.github.com/copilot_internal/user 2>/dev/null)
  if [ "$UCODE" = "200" ]; then
    KEYS=$(json keys "$LOG/copilot-user.json" 2>/dev/null | paste -sd, - | cut -c1-160)
    if grep -qiE 'credit|allowance' "$LOG/copilot-user.json"; then REGIME="AI credits (post-2026-06-01)"
    elif grep -qiE 'quota|premium' "$LOG/copilot-user.json"; then REGIME="legacy premium requests"
    else REGIME="unrecognised"; fi
    record V-13 PASS "Copilot billing regime identified" "$REGIME; keys=$KEYS — EXT-09 is written against these"
  else
    record V-13 FAIL "Copilot billing regime identified" \
      "copilot_internal/user=$UCODE ⇒ quota segment renders '—', REQ-EXT-45 degrades to a local request counter (−0.5 d off EXT-09)"
  fi
fi

# ---------------------------------------------------------------------------- V-08 (needs a model)
if [ "$WITH_MODEL" != 1 ] || [ -z "$MODEL" ]; then
  record V-08 SKIP "extension can abort in print mode" "needs --with-model --model <provider/id>"
else
  V08_DIR="$WORKDIR/v08"; V08_PKG="$WORKDIR/v08pkg"
  mkdir -p "$V08_DIR" "$V08_PKG/extensions"
  cat > "$V08_PKG/extensions/abort-probe.ts" <<'TS'
export default function (pi: any) {
  let n = 0;
  const tryExit = async (ctx: any) => {
    console.error("CALLING_SHUTDOWN");
    try { await ctx.shutdown(); } catch (e) { console.error("SHUTDOWN_THREW=" + e); }
    console.error("STILL_ALIVE_AFTER_SHUTDOWN");
    console.error("CALLING_ABORT");
    try { await ctx.abort(); } catch (e) { console.error("ABORT_THREW=" + e); }
    console.error("STILL_ALIVE_AFTER_ABORT");
  };
  pi.on("session_before_compact", async (_e: any, ctx: any) => {
    if (++n >= 2) await tryExit(ctx);
  });
  pi.on("turn_end", async (_e: any, ctx: any) => { if (++n >= 3) await tryExit(ctx); });
}
TS
  printf '{"packages":["%s"],"defaultProjectTrust":"always"}\n' "$V08_PKG" > "$V08_DIR/settings.json"
  PI_CODING_AGENT_DIR="$V08_DIR" TO 240 pi -p \
    "Count from 1 to 40, one number per message turn, using a bash echo for each. Do not stop early." \
    --model "$MODEL" </dev/null > "$LOG/v08.out" 2> "$LOG/v08.err"
  V08_EXIT=$?
  if grep -q 'STILL_ALIVE_AFTER_ABORT' "$LOG/v08.err" 2>/dev/null; then
    record V-08 FAIL "extension can abort in print mode" \
      "abort() returned and the loop continued ⇒ compaction loop guard exits via bin/pi-run + sentinel file (+1 d, README disclosure)"
  elif grep -q 'CALLING_ABORT' "$LOG/v08.err" 2>/dev/null; then
    if [ "$V08_EXIT" -ne 0 ] && [ "$V08_EXIT" -ne 124 ]; then
      record V-08 PASS "extension can abort in print mode" "loop stopped, exit=$V08_EXIT — in-process guard works"
    else
      record V-08 WARN "extension can abort in print mode" \
        "loop stopped but exit=$V08_EXIT — abort works, exit code still comes from bin/pi-run (shared with REQ-PRV-35)"
    fi
  else
    record V-08 WARN "extension can abort in print mode" "abort path never reached; see $LOG/v08.err — re-run by hand per docs/operations/verification.md"
  fi
fi

# ---------------------------------------------------------------------------- V-17b truncation (needs a model)
if [ "$WITH_MODEL" != 1 ] || [ -z "$MODEL" ]; then
  record V-17b SKIP "bash output truncation boundary" "needs --with-model"
else
  TO 180 pi -p 'Run exactly this bash command and then stop: seq 1 5000' --mode json --model "$MODEL" \
    </dev/null > "$LOG/v17.json" 2> "$LOG/v17.err"
  FOP=$(json find-key "$LOG/v17.json" fullOutputPath 2>/dev/null | head -1)
  if [ -n "$FOP" ] && [ -f "$FOP" ]; then
    record V-17b PASS "truncated bash output is retrievable" "fullOutputPath=$FOP ($(wc -l < "$FOP" | tr -d ' ') lines) — document the rule in EXT-18"
  else
    record V-17b WARN "truncated bash output is retrievable" "no fullOutputPath in the stream; inspect $LOG/v17.json by hand"
  fi
fi

# ---------------------------------------------------------------------------- V-17a ceiling (slow)
if [ "$WITH_SLOW" != 1 ] || [ "$WITH_MODEL" != 1 ] || [ -z "$MODEL" ]; then
  record V-17a SKIP "bash accepts a >= 60 min timeout" "needs --with-slow --with-model (62 minutes wall clock)"
else
  START=$(date +%s)
  TO 4200 pi -p 'Run this exact bash command with a timeout of 3700 seconds: sleep 3700 && echo DONE-3700' \
    --model "$MODEL" </dev/null > "$LOG/v17a.out" 2>&1
  ELAPSED=$(( $(date +%s) - START ))
  if grep -q 'DONE-3700' "$LOG/v17a.out"; then
    record V-17a PASS "bash accepts a >= 60 min timeout" "completed in ${ELAPSED}s — long builds can run inline"
  else
    record V-17a FAIL "bash accepts a >= 60 min timeout" \
      "killed after ~${ELAPSED}s ⇒ long builds go through EXT-24 background jobs; EXT-24 moves out of W3"
  fi
fi

# ---------------------------------------------------------------------------- V-22b offline w/ local model
if [ -z "$LOCAL_MODEL" ]; then
  record V-22b SKIP "offline run against a local model" "pass --local-model <provider/id>; only meaningful if you run a local OpenAI-compatible server"
else
  PI_OFFLINE=1 TO 120 pi -p "reply with the single word ok" --model "$LOCAL_MODEL" </dev/null > "$LOG/v22b.out" 2>&1
  if [ $? -eq 0 ] && grep -qi 'ok' "$LOG/v22b.out"; then
    record V-22b PASS "offline run against a local model" "PI_OFFLINE=1 + local provider works"
  else
    record V-22b FAIL "offline run against a local model" "see $LOG/v22b.out"
  fi
fi

# ---------------------------------------------------------------------------- items that cannot be scripted
record V-21 MANUAL "third-party Copilot client permitted (policy)" "ask your organisation's IT/security owner in writing, before you rely on the Copilot lane"
record V-02 MANUAL "MCP adapter defers tool schemas"              "needs the vendored adapter + a configured server"
record V-03 MANUAL "adapter accepts a caller-supplied config path" "read the adapter source + one isolated-dir run"
record V-07 MANUAL "MCP image results reach the model"             "playwright screenshot + a pixels-only question"
record V-09 MANUAL "model_select fires for nested sessions"        "needs the model-router extension loaded; run a sub-agent and watch which model answers"
record V-10 MANUAL "todo package is file-backed and editable"      "install, create 3 items, find -newer, hand-edit, reload"
record V-11 MANUAL "SQLite session backend safe on live sessions"  "run against a COPY of the session dir only"
record V-18 MANUAL "guardrails switchable off from inside"         "interactive; a FAIL here is expected — the agent can disable its own guardrails, and the README says so"
record V-19 SKIP   "gateway forwards cache_control upstream"       "only applies behind an OpenAI-compatible gateway; probe it against your own gateway by hand"
record V-20 MANUAL "endpoints serve the advertised context window" "canary prompt at 80% of the declared window, per route"
record V-23 MANUAL "large paste becomes an attachment"             "paste ~200 KB, inspect the session JSONL"

# ---------------------------------------------------------------------------- output
N_PASS=0; N_FAIL=0; N_WARN=0; N_SKIP=0; N_MAN=0
for s in "${STATUSES[@]}"; do
  case "$s" in PASS) N_PASS=$((N_PASS+1));; FAIL) N_FAIL=$((N_FAIL+1));;
               WARN) N_WARN=$((N_WARN+1));; SKIP) N_SKIP=$((N_SKIP+1));; MANUAL) N_MAN=$((N_MAN+1));; esac
done

if [ "$AS_JSON" = 1 ]; then
  printf '{"date":"%s","pi":"%s","results":[' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PI_VERSION"
  for i in "${!IDS[@]}"; do
    [ "$i" -gt 0 ] && printf ','
    printf '{"id":%s,"status":%s,"title":%s,"detail":%s}' \
      "$(json string "${IDS[$i]}")" "$(json string "${STATUSES[$i]}")" \
      "$(json string "${TITLES[$i]}")" "$(json string "${DETAILS[$i]}")"
  done
  printf '],"summary":{"pass":%d,"fail":%d,"warn":%d,"skip":%d,"manual":%d}}\n' \
    "$N_PASS" "$N_FAIL" "$N_WARN" "$N_SKIP" "$N_MAN"
else
  if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; B=$'\033[2m'; Z=$'\033[0m'
  else G=""; R=""; Y=""; B=""; Z=""; fi
  echo
  echo "PI environment verification — $(date '+%Y-%m-%d %H:%M')  pi=${PI_VERSION:-?}  workdir=$WORKDIR"
  printf '%s\n' "--------------------------------------------------------------------------------"
  for i in "${!IDS[@]}"; do
    case "${STATUSES[$i]}" in
      PASS) C="$G";; FAIL) C="$R";; WARN) C="$Y";; *) C="$B";;
    esac
    printf '%s%-6s%s  %-8s %s\n' "$C" "${STATUSES[$i]}" "$Z" "${IDS[$i]}" "${TITLES[$i]}"
    [ -n "${DETAILS[$i]}" ] && printf '        %s%s%s\n' "$B" "${DETAILS[$i]}" "$Z"
  done
  printf '%s\n' "--------------------------------------------------------------------------------"
  printf 'pass=%d fail=%d warn=%d skip=%d manual=%d   raw output: %s\n' \
    "$N_PASS" "$N_FAIL" "$N_WARN" "$N_SKIP" "$N_MAN" "$LOG"
  if [ "$N_FAIL" -gt 0 ]; then
    echo
    echo "${R}Read the FAIL rows against docs/operations/verification.md before you rely on this install.${Z}"
    echo "  https://dresvyanskiydenis.github.io/PiON/operations/verification/"
    echo "A FAIL on V-12, V-01 or V-08 changes what gets built, not just how."
  fi
  echo "Keep this table with the date: it is the baseline the next run is compared against."
fi

[ "$N_FAIL" -gt 0 ] && exit 1
exit 0
