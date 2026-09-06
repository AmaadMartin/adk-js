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
 * Re-injects function-call events that compaction removed.
 *
 * Compaction can summarize away a `functionCall` while a matching
 * `functionResponse` survives outside the compacted range. The clearest case is
 * a long-running tool call: the call is compacted along with its intermediate
 * placeholder response, then the real result arrives on resume. That surviving
 * response would be orphaned, which makes prompt assembly throw in
 * `rearrangeEventsForLatestFunctionResponse`.
 *
 * The whole call event is re-injected verbatim rather than trimmed to the
 * resumed call, because a parallel call carries its thought signature on the
 * first part only. Sibling responses that compaction removed come back too, so
 * a sibling is not surfaced as a phantom pending call.
 *
 * @param events: The post-compaction events being assembled into contents.
 * @param sourceEvents: The pre-compaction events to recover missing calls from.
 *
 * @returns `events` with the recoverable call events re-injected, or `events`
 *     itself when there is nothing to recover.
 */
export function recoverCompactedFunctionCalls(
  events: Event[],
  sourceEvents: Event[],
): Event[] {
  const callIdsPresent = new Set<string>();
  const responseIdsPresent = new Set<string>();
  for (const event of events) {
    for (const functionCall of getFunctionCalls(event)) {
      if (functionCall.id) {
        callIdsPresent.add(functionCall.id);
      }
    }
    for (const functionResponse of getFunctionResponses(event)) {
      if (functionResponse.id) {
        responseIdsPresent.add(functionResponse.id);
      }
    }
  }

  const orphanedIds = new Set(
    [...responseIdsPresent].filter((id) => !callIdsPresent.has(id)),
  );
  if (orphanedIds.size === 0) {
    return events;
  }

  const callEventById = new Map<string, Event>();
  for (const event of sourceEvents) {
    for (const functionCall of getFunctionCalls(event)) {
      if (
        functionCall.id &&
        orphanedIds.has(functionCall.id) &&
        !callEventById.has(functionCall.id)
      ) {
        callEventById.set(functionCall.id, event);
      }
    }
  }
  if (callEventById.size === 0) {
    return events;
  }

  // Keep the highest-timestamp response per id so a sibling that completed
  // before being compacted contributes its real result, not its stale
  // placeholder; ties fall back to source order.
  const responseEventById = new Map<string, Event>();
  for (const event of sourceEvents) {
    for (const functionResponse of getFunctionResponses(event)) {
      if (!functionResponse.id) {
        continue;
      }
      const existing = responseEventById.get(functionResponse.id);
      if (!existing || event.timestamp >= existing.timestamp) {
        responseEventById.set(functionResponse.id, event);
      }
    }
  }

  const result: Event[] = [];
  const reinjectedIds = new Set<string>();
  for (const event of events) {
    for (const functionResponse of getFunctionResponses(event)) {
      const responseId = functionResponse.id;
      if (!responseId || reinjectedIds.has(responseId)) {
        continue;
      }
      const callEvent = callEventById.get(responseId);
      if (!callEvent) {
        continue;
      }
      result.push(callEvent);
      const siblingIds = getFunctionCalls(callEvent)
        .map((functionCall) => functionCall.id)
        .filter((id): id is string => !!id);
      for (const siblingId of siblingIds) {
        reinjectedIds.add(siblingId);
      }
      for (const siblingId of siblingIds) {
        if (responseIdsPresent.has(siblingId)) {
          continue;
        }
        const siblingResponse = responseEventById.get(siblingId);
        if (siblingResponse) {
          result.push(siblingResponse);
        }
      }
    }
    result.push(event);
  }
  return result;
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
