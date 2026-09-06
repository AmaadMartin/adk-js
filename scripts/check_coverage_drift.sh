#!/bin/bash
#
# @license
# Copyright 2026 Google LLC
# SPDX-License-Identifier: Apache-2.0
#
# Reports (but never enforces) drift between the coverage thresholds committed in
# vitest.config.ts and the coverage the test suite actually achieves.
#
# This is a CI-only step. It runs immediately after the coverage run on the
# ubuntu leg of .github/workflows/validation.yaml, which passes
# --coverage.thresholds.autoUpdate. That flag makes Vitest rewrite the threshold
# numbers in vitest.config.ts in place whenever real coverage is higher than the
# committed values; this script turns that rewrite into a report and then
# reverts the file, so the numbers Vitest computed are surfaced without anything
# being committed. It always exits 0 for coverage drift: the hard gate stays
# with Vitest's own threshold check.
#
# Reverting is why the script refuses to run outside CI: it would discard
# uncommitted edits to vitest.config.ts that it did not make.
#
# The flag requires coverage.thresholds in vitest.config.ts to stay a plain
# object literal; Vitest cannot rewrite a spread or an imported constant.

set -uo pipefail

CONFIG_FILE="vitest.config.ts"
TOLERANCE_PP=1

if [ -z "${CI:-}" ]; then
  echo "Error: this script reverts $CONFIG_FILE and would discard uncommitted changes to it." >&2
  echo "It is meant to run in CI. Set CI=1 to run it anyway." >&2
  exit 1
fi

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Error: $CONFIG_FILE not found. Run this script from the repository root." >&2
  exit 1
fi

if git diff --quiet -- "$CONFIG_FILE"; then
  echo "✅ Coverage thresholds in $CONFIG_FILE match the coverage actually achieved."
  exit 0
fi

DIFF=$(git diff -U0 -- "$CONFIG_FILE")

# Max drift on the first line, then one line per metric.
REPORT=$(awk '
  $1 ~ /^[-+]$/ && $2 ~ /^(statements|branches|functions|lines):$/ {
    k = $2; sub(/:$/, "", k); v = $3; sub(/,$/, "", v)
    if ($1 == "-") prev[k] = v + 0; else cur[k] = v + 0
  }
  END {
    n = split("statements branches functions lines", keys, " ")
    for (i = 1; i <= n; i++) {
      k = keys[i]
      if (!(k in cur) || !(k in prev)) continue
      d = cur[k] - prev[k]
      if (d > max) max = d
      table = table sprintf("  %-11s %6.2f -> %6.2f  (+%.2f pp)\n", k, prev[k], cur[k], d)
    }
    printf "%.2f\n%s", max, table
  }
' <<<"$DIFF")

MAX_DRIFT=$(head -1 <<<"$REPORT")
DELTAS=$(tail -n +2 <<<"$REPORT")
SUGGESTED=$(grep -E '^\+ +(statements|branches|functions|lines):' <<<"$DIFF" | sed 's/^+//')

# Always hand the working tree back exactly as CI checked it out. A failure here
# would otherwise resurface as a confusing format:check error three steps later.
if ! git checkout -- "$CONFIG_FILE"; then
  echo "Error: failed to revert $CONFIG_FILE; later workflow steps would see a dirty tree." >&2
  exit 1
fi

echo "Coverage thresholds vs. coverage actually achieved:"
echo "$DELTAS"

if awk -v drift="$MAX_DRIFT" -v tolerance="$TOLERANCE_PP" \
  'BEGIN { exit !(drift > tolerance) }'; then
  echo "::warning title=Coverage thresholds are stale::Real coverage exceeds the thresholds in ${CONFIG_FILE} by up to ${MAX_DRIFT} pp (tolerance ${TOLERANCE_PP} pp). Raise the thresholds so the gate keeps catching regressions."
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo "### ⚠️ Coverage thresholds are stale"
      echo
      echo "Real coverage exceeds the thresholds committed in \`${CONFIG_FILE}\` by up to **${MAX_DRIFT} pp**."
      echo "Until they are raised, the gate cannot catch a regression of that size."
      echo
      echo '```'
      echo "$DELTAS"
      echo '```'
      echo
      echo "Suggested \`coverage.thresholds\` block:"
      echo
      echo '```ts'
      echo "$SUGGESTED"
      echo '```'
    } >>"$GITHUB_STEP_SUMMARY"
  fi
else
  echo "Drift is ${MAX_DRIFT} pp, within the ${TOLERANCE_PP} pp tolerance. Not reporting."
fi

exit 0
