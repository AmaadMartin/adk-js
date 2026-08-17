/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {createEvent, Event} from './event.js';

/**
 * A compaction event paired with its position in the event stream.
 *
 * The index is part of a compaction's identity: two compactions can cover the
 * same range, and the stream position is what breaks the tie.
 */
interface IndexedCompaction {
  index: number;
  startTimestamp: number;
  endTimestamp: number;
  compactedContent: Content;
  event: Event;
}

/**
 * Returns the compaction events whose range is fully specified.
 *
 * A partially written compaction (missing a bound or the summary itself) cannot
 * stand in for anything, so it is ignored rather than trusted.
 *
 * Mirrors `google/adk-python` `_valid_compactions`.
 */
function getValidCompactions(events: Event[]): IndexedCompaction[] {
  const compactions: IndexedCompaction[] = [];
  events.forEach((event, index) => {
    const compaction = event.actions?.compaction;
    if (
      compaction?.startTimestamp === undefined ||
      compaction.endTimestamp === undefined ||
      compaction.compactedContent === undefined
    ) {
      return;
    }
    compactions.push({
      index,
      startTimestamp: compaction.startTimestamp,
      endTimestamp: compaction.endTimestamp,
      compactedContent: compaction.compactedContent,
      event,
    });
  });
  return compactions;
}

/**
 * Whether a compaction range is fully contained by another one.
 *
 * A wider summary supersedes a narrower one. When two ranges are identical the
 * later event wins, so the earlier one is the subsumed one.
 *
 * Mirrors `google/adk-python` `_is_compaction_subsumed`.
 */
function isCompactionSubsumed(
  compaction: IndexedCompaction,
  compactions: IndexedCompaction[],
): boolean {
  return compactions.some((other) => {
    if (other.index === compaction.index) {
      return false;
    }
    if (
      other.startTimestamp > compaction.startTimestamp ||
      other.endTimestamp < compaction.endTimestamp
    ) {
      return false;
    }
    return (
      other.startTimestamp < compaction.startTimestamp ||
      other.endTimestamp > compaction.endTimestamp ||
      other.index > compaction.index
    );
  });
}

/**
 * Substitutes compaction summaries for the raw events they cover.
 *
 * Each non-subsumed summary is materialized as an event at its end timestamp,
 * and every earlier raw event inside a kept range is dropped. Subsumed
 * summaries are dropped outright, so an older narrower summary never doubles up
 * with the wider one that replaced it. The result is sorted by timestamp with
 * the original position as tie-breaker, so events sharing a timestamp keep their
 * original order.
 *
 * The transform is idempotent: running it over its own output changes nothing,
 * because a materialized summary still carries its compaction range and the raw
 * events that range covers are already gone.
 *
 * Mirrors `google/adk-python` `_process_compaction_events`.
 *
 * @param events The events to process, in stream order.
 * @param agentName Author to attribute a materialized summary to, so an agent
 *   reads its compacted history as its own prior turns. Defaults to `'model'`.
 * @returns The events with compaction applied.
 */
export function applyEventCompactions(
  events: Event[],
  agentName = '',
): Event[] {
  const compactions = getValidCompactions(events);
  const kept = compactions.filter(
    (compaction) => !isCompactionSubsumed(compaction, compactions),
  );

  const processed: Array<{timestamp: number; index: number; event: Event}> =
    kept.map(({index, endTimestamp, compactedContent, event}) => ({
      timestamp: endTimestamp,
      index,
      event: createEvent({
        timestamp: endTimestamp,
        author: agentName || 'model',
        content: compactedContent,
        branch: event.branch,
        invocationId: event.invocationId,
        actions: event.actions,
      }),
    }));

  // A compaction only ever covered events that were already in the session when
  // it ran, so an event must also precede it in the stream to be covered by it.
  // `Event.timestamp` is integer milliseconds and a turn appended right after a
  // compaction can share its end timestamp; without the position test that turn
  // would be silently dropped from the prompt.
  const isCovered = (timestamp: number, index: number): boolean =>
    kept.some(
      (compaction) =>
        index < compaction.index &&
        compaction.startTimestamp <= timestamp &&
        timestamp <= compaction.endTimestamp,
    );

  events.forEach((event, index) => {
    if (event.actions?.compaction || isCovered(event.timestamp, index)) {
      return;
    }
    processed.push({timestamp: event.timestamp, index, event});
  });

  processed.sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);
  return processed.map((item) => item.event);
}
