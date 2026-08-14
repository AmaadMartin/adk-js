/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event} from './event.js';

/**
 * Returns `events` with rewound invocations removed.
 *
 * Iterates backward. When an event carries
 * `actions.rewindBeforeInvocationId === X`, drops that event together with
 * every event between it and the earliest event of invocation `X` (inclusive),
 * then resumes the backward walk from there. A marker whose target invocation
 * is not present earlier in the history only drops the marker itself.
 *
 * This is the single source of truth for "which events are live" after
 * rewinds. Both LLM prompt building and context compaction must agree on it,
 * otherwise rewound content can leak back into prompts through a compaction
 * summary.
 *
 * The input array and its events are never mutated; the returned array holds
 * the surviving {@link Event} references themselves, so callers that mutate
 * the session history in place keep working.
 *
 * @param events The full event history, in chronological order.
 * @returns The chronological subset of `events` that survives all rewinds.
 */
export function applyRewinds(events: Event[]): Event[] {
  const kept: Event[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const rewindInvocationId = events[i].actions?.rewindBeforeInvocationId;
    if (!rewindInvocationId) {
      kept.push(events[i]);
      continue;
    }
    // The earliest event of the rewound invocation is where the walk resumes.
    // An index at or after the marker means that invocation does not precede
    // it, so only the marker is dropped.
    const resumeIndex = events.findIndex(
      (event) => event.invocationId === rewindInvocationId,
    );
    if (resumeIndex >= 0 && resumeIndex < i) {
      i = resumeIndex;
    }
  }
  return kept.reverse();
}
