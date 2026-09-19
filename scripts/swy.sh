#!/usr/bin/env bash
set -uo pipefail

MAX_ATTEMPTS=6

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  out=$(swytchcode "$@" </dev/null 2>&1)
  code=$?

  if echo "$out" | grep -qE '(429|Rate limit exceeded|Failed to fetch methods)'; then
    wait=$(echo "$out" | grep -oE 'retry in [0-9]+' | grep -oE '[0-9]+' | head -1)
    wait=${wait:-5}
    backoff=$(( wait + attempt * 2 ))
    echo "  … rate-limited on 'swytchcode $*' (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${backoff}s" >&2
    sleep "$backoff"
    continue
  fi

  echo "$out"
  exit "$code"
done

echo "✗ gave up on 'swytchcode $*' after ${MAX_ATTEMPTS} rate-limited attempts" >&2
exit 1
