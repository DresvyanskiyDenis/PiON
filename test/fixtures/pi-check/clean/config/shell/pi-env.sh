#!/usr/bin/env bash
# pi-env.sh — test-fixture copy. No secret values (REQ-PRV-13).

export PI_TELEMETRY=0
unset PI_EXPERIMENTAL    # MUST never be set (REQ-PRV-56)

# --- Secrets: references only -------------------------------------------------
# Example shapes (documentation only, not real values):
#   ACME_API_KEY=sk-...
if [ -r "$HOME/.pi/secrets.env" ]; then
  set -a
  . "$HOME/.pi/secrets.env"
  set +a
fi
