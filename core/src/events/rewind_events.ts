/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from './event.js';

/**
 * Returns `events` with rewound invocations removed.
 *
 * The walk runs backward. When an event carries
 * `actions.rewindBeforeInvocationId === X`, it drops that event together with
 * every event back to the earliest event of invocation `X` inclusive, then
 * resumes the walk from there. A marker whose target invocation does not
 * appear earlier in the history drops only the marker.
 *
 * This is the single source of truth for which events are live after a rewind.
 * Prompt building and context compaction must agree on it, or rewound content
 * reaches the model again through a compaction summary.
 *
 * The input array and its events are never mutated. The returned array holds
 * the surviving {@link Event} references themselves.
 *
 * @param events The full event history, in chronological order.
 * @returns The chronological subset of `events` that survives every rewind.
 */
export function applyRewinds(events: Event[]): Event[] {
  const kept: Event[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const rewindInvocationId = events[i].actions?.rewindBeforeInvocationId;
    if (!rewindInvocationId) {
      kept.push(events[i]);
      continue;
    }
    const resumeIndex = events.findIndex(
      (event) => event.invocationId === rewindInvocationId,
    );
    if (resumeIndex >= 0 && resumeIndex < i) {
      i = resumeIndex;
    }
  }
  return kept.reverse();
}
