/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from '../events/event.js';

/**
 * Checks whether targetBranch is equal to or an ancestor of currentBranch
 * by verifying segment-by-segment matching without substring false positives.
 *
 * @param currentBranch The branch being evaluated.
 * @param targetBranch The candidate prefix or ancestor branch.
 * @returns true if targetBranch equals currentBranch or is an ancestor of currentBranch.
 */
export function isSegmentPrefix(
  currentBranch: string,
  targetBranch: string,
): boolean {
  return (
    !targetBranch ||
    targetBranch === currentBranch ||
    (!!currentBranch && currentBranch.startsWith(`${targetBranch}.`))
  );
}

/**
 * Checks whether `event` is visible from `currentBranch` under exact matching.
 *
 * An event with no branch was appended at the invocation root, so every branch
 * sees it. A branched event must equal `currentBranch`: unlike
 * {@link isSegmentPrefix}, an ancestor branch does not match here. Use this
 * where an ancestor's history must stay out of scope. Interaction chaining
 * does, mirroring `_is_event_in_branch` in google/adk-python
 * `flows/llm_flows/interactions_processor.py`.
 *
 * @param currentBranch The branch being evaluated, or undefined at the root.
 * @param event The event to test.
 * @returns true if the event is visible from currentBranch.
 */
export function isEventInBranch(
  currentBranch: string | undefined,
  event: Event,
): boolean {
  return !event.branch || event.branch === currentBranch;
}
