/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {longestSelfContainedPrefix} from '../context/compaction_utils.js';
import {isCompactedEvent} from '../events/compacted_event.js';
import {Event} from '../events/event.js';
import {Session} from '../sessions/session.js';

import {EventsCompactionConfig} from './events_compaction_config.js';

/**
 * Runs the sliding-window compaction trigger over a session.
 *
 * The window advances a whole invocation at a time. Once `compactionInterval`
 * invocations have arrived since the last summary, the events of those
 * invocations are summarized together with `overlapSize` earlier invocations,
 * so consecutive summaries share context instead of butting up against each
 * other.
 *
 * The window is trimmed to its longest self-contained prefix, so a turn that
 * ended awaiting a tool, a confirmation or user input keeps its unanswered
 * call raw. Summarizing past it would leave the next request carrying a
 * function response with no matching call.
 *
 * Ported from `google/adk-python`
 * `apps/compaction.py::_run_compaction_for_sliding_window`. Two parts of the
 * Python function are deliberately not ported:
 *
 * - the token-threshold trigger, which ADK for TypeScript serves with
 *   `TokenBasedContextCompactor` instead;
 * - `_apply_rewinds`, because the runner has no rewind pipeline to apply.
 *
 * The generator yields the summary and never writes it. The caller owns the
 * append, so one place decides what reaches storage.
 *
 * @param config The compaction policy. Its sliding-window fields must be set.
 * @param session The session whose events are compacted.
 * @yields One `CompactedEvent` when the window is full, nothing otherwise.
 */
export async function* runSlidingWindowCompaction(
  config: EventsCompactionConfig,
  session: Session,
): AsyncGenerator<Event, void, void> {
  const {summarizer, compactionInterval, overlapSize} = config;
  if (
    !summarizer ||
    compactionInterval === undefined ||
    overlapSize === undefined
  ) {
    return;
  }

  const events = session.events;
  const latestTimestamps = latestTimestampPerInvocation(events);
  const invocationIds = [...latestTimestamps.keys()];
  const compactedUntil = lastCompactedEndTime(events);
  const newInvocationIds = invocationIds.filter(
    (id) => latestTimestamps.get(id)! > compactedUntil,
  );
  if (newInvocationIds.length < compactionInterval) {
    return;
  }

  const firstNewIndex = invocationIds.indexOf(newInvocationIds[0]);
  const startInvocationId =
    invocationIds[Math.max(0, firstNewIndex - overlapSize)];
  const endInvocationId = newInvocationIds[newInvocationIds.length - 1];

  const eventsToCompact = longestSelfContainedPrefix(
    sliceInvocationRange(events, startInvocationId, endInvocationId),
  );
  if (!eventsToCompact.length) {
    return;
  }

  yield await summarizer.summarize(eventsToCompact);
}

/** The end time of the newest compaction summary, or 0 when there is none. */
function lastCompactedEndTime(events: Event[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (isCompactedEvent(event)) {
      return event.endTime;
    }
  }
  return 0;
}

/**
 * The newest timestamp of each raw invocation, keyed in first-seen order.
 *
 * Summaries are left out: they carry the invocation id of the turn that
 * produced them, and counting one would make an already compacted invocation
 * look new.
 */
function latestTimestampPerInvocation(events: Event[]): Map<string, number> {
  const latest = new Map<string, number>();
  for (const event of events) {
    if (!event.invocationId || isCompactedEvent(event)) {
      continue;
    }
    const previous = latest.get(event.invocationId) ?? 0;
    latest.set(event.invocationId, Math.max(previous, event.timestamp));
  }
  return latest;
}

/**
 * The raw events from the first event of `startInvocationId` through the last
 * event of `endInvocationId`, with earlier summaries left out.
 */
function sliceInvocationRange(
  events: Event[],
  startInvocationId: string,
  endInvocationId: string,
): Event[] {
  const start = events.findIndex((e) => e.invocationId === startInvocationId);
  let end = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].invocationId === endInvocationId) {
      end = i;
      break;
    }
  }
  if (start === -1 || end === -1) {
    return [];
  }
  return events.slice(start, end + 1).filter((e) => !isCompactedEvent(e));
}
