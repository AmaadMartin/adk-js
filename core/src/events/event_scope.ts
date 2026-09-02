/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isSegmentPrefix} from '../utils/branch_trie.js';
import {Event} from './event.js';

/**
 * The session events an invocation may act on: those on the current branch.
 *
 * Work belongs to the branch that raised it. Without this an agent could act
 * on a sibling branch's events — a paused call nobody showed it, or a
 * credential request for a tool it may not even have. Mirrors Python's
 * `_get_events(current_branch=True)`.
 *
 * An event with no branch is always in scope, and so is one on an ancestor
 * branch, because both are visible to every descendant.
 */
export function eventsOnCurrentBranch(
  events: Event[],
  currentBranch: string | undefined,
): Event[] {
  if (!currentBranch) {
    return events;
  }
  return events.filter(
    (event) => !event.branch || isSegmentPrefix(currentBranch, event.branch),
  );
}
