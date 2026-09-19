#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

PAIRS=(
  "email:gmail:Google OAuth — read-only inbox access"
  "calendar:google-calendar:Google OAuth — read-only calendar access"
  "notes:notion:Notion integration token"
  "briefing:resend:Resend API key"
)

bold "Rackey — connect provider credentials"
echo

if ! swytchcode whoami >/dev/null 2>&1; then
  bold "Not logged in. Opening Swytchcode login…"
  swytchcode login || { echo "✗ login failed"; exit 1; }
  echo
fi

swytchcode whoami 2>/dev/null | grep -E "email|session" || true
echo

for pair in "${PAIRS[@]}"; do
  agent="${pair%%:*}"; rest="${pair#*:}"
  provider="${rest%%:*}"; desc="${rest#*:}"

  bold "→ ${agent} agent  (${provider})"
  dim  "  ${desc}"

  line=$(cd "$ROOT/agents/$agent" && swytchcode auth status 2>/dev/null | grep "$provider" || true)
  if [ -n "$line" ] && ! echo "$line" | grep -qi "expired"; then
    dim "  already connected — skipping"
    echo
    continue
  fi
  if echo "$line" | grep -qi "expired"; then
    dim "  token EXPIRED — reconnecting"
  fi

  (cd "$ROOT/agents/$agent" && swytchcode auth connect "$provider") || {
    echo "  ✗ failed to connect $provider for $agent"
    echo "    retry manually:  cd agents/$agent && swytchcode auth connect $provider"
  }
  echo
done

bold "Connection summary"
for pair in "${PAIRS[@]}"; do
  agent="${pair%%:*}"
  printf '  %-9s ' "$agent"
  (cd "$ROOT/agents/$agent" && swytchcode auth status 2>/dev/null | tail -n +2 | tr '\n' ' ') || true
  echo
done

echo
dim "Next: python3 scripts/reset-scopes.py --check   (confirm no scope drift)"
dim "Then: npm run boundary                          (confirm the boundary holds)"
