/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isCompactedEvent} from '../events/compacted_event.js';
import {
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';

/**
 * Filters the events to return only the active events since the latest compaction.
 * If no compaction has occurred, returns all events.
 *
 * @param events The full history of events.
 * @returns The active events, starting with the latest CompactedEvent if present.
 */
export function getActiveEvents(events: Event[]): Event[] {
  const latest = events.filter(isCompactedEvent).pop();
  return latest
    ? [
        latest,
        ...events.filter(
          (e) => !isCompactedEvent(e) && e.timestamp > latest.endTime,
        ),
      ]
    : events;
}

/**
 * The longest prefix of `events` that leaves no obligation open.
 *
 * A function call, a tool-confirmation request and an auth request each open
 * an obligation keyed by its call id, and a function response with the same id
 * closes it. Summarizing past an open obligation drops the call while the
 * matching response survives as a raw event, and the model then receives a
 * response it has no call for.
 *
 * Responses are applied before calls within one event, so a response only ever
 * closes an obligation an earlier event opened. Ported from `google/adk-python`
 * `apps/compaction.py::_longest_self_contained_prefix`.
 *
 * @param events The candidate window, in session order.
 * @returns The prefix ending at the last balanced point, empty when the window
 *   never reaches one.
 */
export function longestSelfContainedPrefix(events: Event[]): Event[] {
  const openIds = new Set<string>();
  let safeLength = 0;

  events.forEach((event, index) => {
    for (const response of getFunctionResponses(event)) {
      if (response.id) {
        openIds.delete(response.id);
      }
    }
    for (const call of getFunctionCalls(event)) {
      if (call.id) {
        openIds.add(call.id);
      }
    }
    for (const id of Object.keys(event.actions.requestedToolConfirmations)) {
      openIds.add(id);
    }
    for (const id of Object.keys(event.actions.requestedAuthConfigs)) {
      openIds.add(id);
    }
    if (openIds.size === 0) {
      safeLength = index + 1;
    }
  });

  return events.slice(0, safeLength);
}

/**
 * Determines the baseline index to retain from active raw events,
 * ensuring we don't split between a function call and its response.
 *
 * @param rawEvents The active raw events to consider for compaction.
 * @param eventRetentionSize The minimum number of raw events to keep at the end of the session.
 * @returns The index in `rawEvents` at which to split. Events before this index will be compacted.
 */
export function calculateRetainStartIndex(
  rawEvents: Event[],
  eventRetentionSize: number,
): number {
  let retainStartIndex = Math.max(0, rawEvents.length - eventRetentionSize);

  // Prevent splitting between a tool call and its response.
  while (retainStartIndex > 0) {
    const eventToRetain = rawEvents[retainStartIndex];
    const previousEvent = rawEvents[retainStartIndex - 1];

    if (
      getFunctionResponses(eventToRetain).length > 0 &&
      getFunctionCalls(previousEvent).length > 0
    ) {
      retainStartIndex--;
    } else {
      // No conflict, safe to split here.
      break;
    }
  }

  return retainStartIndex;
}
