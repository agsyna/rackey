#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0
MODE="${1:-all}"

green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1"; }
bold()  { printf '\033[1m%s\033[0m\n' "$1"; }

ok()   { green "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { red   "  ✗ $1"; FAIL=$((FAIL+1)); }

SCOPES=(
  "email|gmail.user.messages.get,gmail.user.messages.get1"
  "calendar|calendar.event.get,calendar.event.get.1"
  "notes|notion.page.create,notion.page.update"
  "briefing|resend.email.create"
)

scope_audit() {
  bold "Layer 1 — scope audit (exact capability sets, offline)"
  for entry in "${SCOPES[@]}"; do
    agent="${entry%%|*}"
    expected="${entry#*|}"
    tj="$ROOT/agents/$agent/.swytchcode/tooling.json"

    if [[ ! -f "$tj" ]]; then
      bad "$agent: no tooling.json at $tj"
      continue
    fi

    actual=$(python3 -c "
import json,sys
print(','.join(sorted(json.load(open(sys.argv[1]))['tools'])))
" "$tj")

    if [[ "$actual" == "$expected" ]]; then
      ok "$agent holds exactly: $actual"
    else
      bad "$agent scope drift
      expected: $expected
      actual:   $actual"
    fi
  done
  echo
}

DENIED=(
  "email|resend.email.create|the inbox reader must not be able to send mail"
  "briefing|gmail.user.messages.get|the sender must not be able to read the inbox"
  "calendar|calendar.event.update|the calendar agent must not be able to move meetings"
  "notes|notion.page.get|the notes writer is write-only and must not read back"
)

live_enforcement() {
  bold "Layer 2 — live enforcement (kernel actually refuses; ~15s each)"
  for entry in "${DENIED[@]}"; do
    agent="${entry%%|*}"
    rest="${entry#*|}"
    tool="${rest%%|*}"
    why="${rest#*|}"

    out=$(cd "$ROOT/agents/$agent" && swytchcode exec "$tool" --explain --json </dev/null 2>&1)

    if echo "$out" | grep -q "is not configured in this project's tooling.json"; then
      ok "$agent → $tool BLOCKED"
      echo "      ($why)"
    else
      bad "$agent → $tool WAS NOT BLOCKED — capability leak
      $why
      output: $(echo "$out" | tail -3)"
    fi
  done
  echo
}

bold "Rackey policy-boundary test"
echo
[[ "$MODE" != "--live-only"  ]] && scope_audit
[[ "$MODE" != "--scope-only" ]] && live_enforcement

bold "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]] || exit 1
