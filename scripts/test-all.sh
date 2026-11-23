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
# Some machines carry a Chromium that Playwright did not download itself, in
# which case Playwright looks for one it does not have and every UI suite fails
# for want of a browser rather than because anything is wrong. Use the one that
# is here, unless a path was given.
if [ -z "$FORGE_CHROMIUM" ] && [ -x /opt/pw-browsers/chromium ]; then
  export FORGE_CHROMIUM=/opt/pw-browsers/chromium
fi
SUITES=(settings-ui journeys-ui mcp-ui mailsetup-ui cloud-ui browser-ui chat-ui agents-ui documents-ui search-ui responsive-ui mail-ui boot-ui mailbox-ui systems-ui people-ui context-ui)
FAILED=()

echo "== unit tests"
# Run once and keep the output: running twice doubled the time, and piping
# through `tail -20` cut the summary lines it was meant to print, so the
# header said "1" while the real counts scrolled past.
UNIT_OUT=$(node --test tests/*.test.cjs 2>&1)
echo "$UNIT_OUT" | grep -E "^# (tests|pass|fail|skipped)" || echo "(no summary line — see above)"
UNIT_FAIL=$(echo "$UNIT_OUT" | grep -E "^# fail" | awk '{print $3}')
if [ "${UNIT_FAIL:-1}" != "0" ]; then
  echo "$UNIT_OUT" | grep -E "^not ok" | head -10
  FAILED+=("unit (${UNIT_FAIL:-unknown} failing)")
fi

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
