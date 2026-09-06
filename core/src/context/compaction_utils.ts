/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CompactedEvent, isCompactedEvent} from '../events/compacted_event.js';
import {
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';

/**
 * Filters the events to return only the active events since the latest event
 * matching `isAnchor`. If no such event exists, returns all events.
 *
 * The boundary is {@link CompactedEvent.retainFromEventId}.
 *
 * @param events The full history of events.
 * @param isAnchor Identifies the compacted events this boundary applies to.
 * @returns The active events, starting with the latest anchor if present.
 */
export function getActiveEventsSince(
  events: Event[],
  isAnchor: (event: Event) => event is CompactedEvent,
): Event[] {
  let anchor: CompactedEvent | undefined = undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (isAnchor(event)) {
      anchor = event;
      break;
    }
  }

  if (!anchor) {
    return events;
  }

  const startIndex = anchor.retainFromEventId
    ? events.findIndex((e) => e.id === anchor.retainFromEventId)
    : -1;

  // An anchor written before `retainFromEventId` existed, or read back from a
  // store that rewrites event ids, has no resolvable boundary. Those keep the
  // timestamp rule, which retains too little rather than nothing.
  const activeRawEvents =
    startIndex >= 0
      ? events.slice(startIndex).filter((e) => !isAnchor(e))
      : events.filter((e) => !isAnchor(e) && e.timestamp > anchor.endTime);

  return [anchor, ...activeRawEvents];
}

/**
 * Filters the events to return only the active events since the latest compaction.
 * If no compaction has occurred, returns all events.
 *
 * @param events The full history of events.
 * @returns The active events, starting with the latest CompactedEvent if present.
 */
export function getActiveEvents(events: Event[]): Event[] {
  return getActiveEventsSince(events, isCompactedEvent);
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
