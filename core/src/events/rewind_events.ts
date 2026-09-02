/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event} from './event.js';

/**
 * Returns `events` with the rewound invocations removed.
 *
 * Walks the history backwards. When an event carries
 * `actions.rewindBeforeInvocationId` `X`, this drops that event together with
 * every event back to the earliest event of invocation `X`, inclusive, then
 * continues the backward walk from there.
 *
 * A marker whose target invocation never appears earlier in the history drops
 * only the marker itself, matching adk-python's
 * `google.adk.events._rewind_events._apply_rewinds`.
 *
 * @param events The full event history, in chronological order.
 * @returns The chronological subset of `events` that survives every rewind.
 *   Neither the input array nor any event in it is modified.
 */
export function applyRewinds(events: Event[]): Event[] {
  const kept: Event[] = [];
  let i = events.length - 1;
  while (i >= 0) {
    const rewindTarget = events[i].actions?.rewindBeforeInvocationId;
    if (rewindTarget) {
      for (let j = 0; j < i; j++) {
        if (events[j].invocationId === rewindTarget) {
          i = j;
          break;
        }
      }
    } else {
      kept.push(events[i]);
    }
    i--;
  }
  return kept.reverse();
}
