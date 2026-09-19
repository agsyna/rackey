#!/usr/bin/env bash
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

swytchcode whoami >/dev/null 2>&1 || swytchcode login

for pair in "email:gmail" "calendar:google-calendar"; do
  agent="${pair%%:*}"; provider="${pair#*:}"
  printf '\033[1m-> %s (%s)\033[0m\n' "$agent" "$provider"

  (cd "$ROOT/agents/$agent" && swytchcode auth disconnect "$provider" >/dev/null 2>&1) || true

  (cd "$ROOT/agents/$agent" && swytchcode auth connect "$provider")
done

printf '\n\033[1mStatus\033[0m\n'
for pair in "email:gmail" "calendar:google-calendar" "notes:notion" "briefing:resend"; do
  agent="${pair%%:*}"
  printf '  %-9s ' "$agent"
  (cd "$ROOT/agents/$agent" && swytchcode auth status 2>/dev/null | tail -n +2) || true
done
