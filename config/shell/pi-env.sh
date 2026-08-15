#!/usr/bin/env bash
# pi-env.sh — environment for the pi coding agent.
# Source from ~/.zshrc:   [ -f ~/.pi/agent/shell/pi-env.sh ] && . ~/.pi/agent/shell/pi-env.sh
#
# This file contains NO SECRET VALUES. It only points at the places secrets live.
# Committing it is safe; `git grep -nE '(sk-|dapi|gho_|ghp_)'` over the repo must stay
# empty and `bin/pi-check` (rule PC-06) enforces that.
#
# Every host-specific value below is a commented-out example. Uncomment and edit the
# ones your setup actually needs; leave the rest alone. `scripts/install.sh` may write
# some of them for you from your answers.

# --- pi runtime posture -------------------------------------------------------
export PI_TELEMETRY=0             # no telemetry egress
export PI_SKIP_VERSION_CHECK=1    # no version ping at startup
unset PI_EXPERIMENTAL             # MUST never be set
# export PI_OFFLINE=1             # opt-in: blocks every non-LLM outbound call
# Required, not merely a convenience: pi-web-access's own getWebSearchConfigDir() falls back to
# "$HOME/.pi" (no "agent") when this is unset, while PI's own getAgentDir() falls back to
# "$HOME/.pi/agent" — two different directories for the same config tree. Exporting this pins both
# to the one config/ symlink target so config/web-search.json is where pi-web-access actually looks.
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
# export PI_SHARE_VIEWER_URL="http://127.0.0.1:9"  # neuter /share

# --- PATH for the shipped helpers --------------------------------------------
case ":$PATH:" in *":$HOME/bin:"*) ;; *) export PATH="$HOME/bin:$PATH" ;; esac

# --- Secrets: references only -------------------------------------------------
# ~/.pi/secrets.env is chmod 600, git-ignored, and NOT part of this repo.
# Shape (one KEY=value per line, no export, no quotes needed) — supply only the ones
# whose provider you actually installed:
#   COPILOT_GITHUB_TOKEN=gho_...       # github-copilot. The apiKey path is the only one that keeps
#                                      #   models.json's baseUrl override intact at request time.
#                                      #   Do NOT run `/login github-copilot` on a data-residency
#                                      #   tenant — see config/providers/github-copilot.json.
#   DATABRICKS_TOKEN=dapi...           # databricks: PAT instead of the OAuth/CLI path
#   <your own name>=...                # openai-compatible: the fragment asks you for the VARIABLE
#                                      #   name, so this line is whatever you answered. An endpoint
#                                      #   that checks no bearer token needs no line at all.
#   PI_COPILOT_QUOTA_TOKEN=ghp_...     # optional: classic PAT for the Copilot quota meter
if [ -r "$HOME/.pi/secrets.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$HOME/.pi/secrets.env"
  set +a
fi

# Keychain alternative (macOS). Costs one keychain read per SHELL START, not per
# request — do NOT put `!security find-generic-password` directly in models.json,
# it would re-execute on every LLM call. Pattern, for whichever key needs it:
#   security add-generic-password -a "$USER" -s pi-<name> -w '<key>'
#   [ -n "${SOME_API_KEY:-}" ] || \
#     export SOME_API_KEY="$(security find-generic-password -a "$USER" -s pi-<name> -w 2>/dev/null)"

# --- Databricks ---------------------------------------------------------------
# Only needed if you installed the `databricks` provider. The hostname, without a
# scheme, is also what config/models.json's baseUrl carries — PI does not expand
# $VAR inside baseUrl, so the two are set independently and must agree.
# export DATABRICKS_HOST="https://<your-workspace-host>"
# export DATABRICKS_CONFIG_PROFILE=DEFAULT

# --- TLS and proxy ------------------------------------------------------------
# Behind a TLS-intercepting proxy, Node needs the interceptor's CA bundle. This is a
# Node variable; confirm your pi build honours it before relying on it.
# export NODE_EXTRA_CA_CERTS="$HOME/.ssl/<your-ca-bundle>.pem"
#
# The standalone pi binary does not parse NODE_OPTIONS at all (verified — an invalid value is
# silently ignored where a real `node` CLI refuses to start), so Node's own
# --use-env-proxy/NODE_OPTIONS trick never reaches it. The two variables below are read directly
# by extensions/web/proxy.ts, which builds its own undici EnvHttpProxyAgent and installs it as the
# global fetch dispatcher — that is what actually makes pi-web-access's web_search/web_fetch honour
# the proxy, not this file by itself.
# export HTTPS_PROXY="http://<your-proxy-host>:<port>"
# export HTTP_PROXY="$HTTPS_PROXY"
# NO_PROXY must always cover loopback, or a local model server is proxied into a
# black hole. Set unconditionally: it is harmless with no proxy configured.
export NO_PROXY="127.0.0.1,localhost,::1,.local"
export no_proxy="$NO_PROXY"

# --- Convenience --------------------------------------------------------------
alias pil='pi --model "$(pi-tier light)"'
alias pis='pi --model "$(pi-tier strong)"'
