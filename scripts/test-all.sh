#!/usr/bin/env bash
# Runs everything and fails if anything failed.
#
# This exists because a shell `for` loop over the suites reports the exit code
# of its last command, so a suite failing in the middle left the whole run
# looking green. A regression got as far as being committed that way. Every
# result is collected and the summary is the last thing printed, so a failure
# cannot scroll out of sight either.
set -uo pipefail
cd "$(dirname "$0")/.."

: "${FORGE_CHROMIUM:=}"
SUITES=(cloud-ui browser-ui chat-ui agents-ui documents-ui search-ui responsive-ui mail-ui)
FAILED=()

echo "== unit tests"
if node --test tests/*.test.cjs 2>&1 | tail -20 | grep -E "^# (tests|pass|fail|skipped)"; then :; fi
UNIT_FAIL=$(node --test tests/*.test.cjs 2>&1 | grep -E "^# fail" | awk '{print $3}')
[ "${UNIT_FAIL:-0}" = "0" ] || FAILED+=("unit (${UNIT_FAIL} failing)")

echo
echo "== building"
pnpm build >/dev/null 2>&1 || { echo "build FAILED"; FAILED+=("build"); }

for s in "${SUITES[@]}"; do
  echo
  echo "== $s"
  if out=$(node "tests/ui/$s.cjs" 2>&1); then
    echo "$out" | tail -1
  else
    echo "$out" | grep -E "^FAIL" -A 3 | head -20
    echo "$out" | tail -1
    FAILED+=("$s")
  fi
done

echo
echo "────────────────────────────"
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "everything passed"
  exit 0
fi
echo "FAILED: ${FAILED[*]}"
exit 1
