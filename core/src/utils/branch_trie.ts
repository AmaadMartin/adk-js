/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Checks whether targetBranch is equal to or an ancestor of currentBranch
 * by verifying segment-by-segment matching without substring false positives.
 *
 * @param currentBranch The branch being evaluated. An absent or empty branch
 *   matches only an absent or empty targetBranch.
 * @param targetBranch The candidate prefix or ancestor branch. An absent or
 *   empty targetBranch matches every currentBranch.
 * @returns true if targetBranch equals currentBranch or is an ancestor of currentBranch.
 */
export function isSegmentPrefix(
  currentBranch: string | undefined,
  targetBranch: string | undefined,
): boolean {
  return (
    !targetBranch ||
    targetBranch === currentBranch ||
    (!!currentBranch && currentBranch.startsWith(`${targetBranch}.`))
  );
}
