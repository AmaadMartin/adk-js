/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Event, createEvent} from './event.js';

/**
 * A specialized Event type that represents a synthesized summary of past events.
 * This is used to compress session history without losing critical context.
 */
export interface CompactedEvent extends Event {
  /**
   * Identifies this event as a compacted event.
   */
  readonly isCompacted: true;

  /**
   * The start time of the context that was compacted.
   */
  startTime: number;

  /**
   * The end time of the context that was compacted.
   */
  endTime: number;

  /**
   * The summarized content of the compacted events.
   */
  compactedContent: string;

  /**
   * Identifies this compacted event as the persistent context scratchpad.
   */
  isScratchpad?: boolean;

  /**
   * The id of the first event this compaction retained. That event, and every
   * raw event positioned after it, stays active.
   *
   * Timestamps cannot express this boundary: `endTime` is the timestamp of the
   * last compacted event, so a retained event created in the same millisecond
   * is indistinguishable from it.
   *
   * The marker is the first retained event rather than the last compacted one
   * because a compactor may drop the compacted events from the list it
   * rebuilds, while the retained events survive in every layout.
   */
  retainFromEventId?: string;
}

/**
 * Type guard to check if an event is a CompactedEvent.
 */
export function isCompactedEvent(event: Event): event is CompactedEvent {
  return 'isCompacted' in event && event.isCompacted === true;
}

/**
 * Type guard to check if an event is a scratchpad CompactedEvent.
 */
export function isScratchpadEvent(
  event: Event,
): event is CompactedEvent & {isScratchpad: true} {
  return (
    isCompactedEvent(event) && (event as CompactedEvent).isScratchpad === true
  );
}

export function createCompactedEvent(
  params: Partial<CompactedEvent> = {},
): CompactedEvent {
  return {
    ...createEvent(params),
    isCompacted: params.isCompacted || true,
    startTime: params.startTime!,
    endTime: params.endTime!,
    compactedContent: params.compactedContent!,
    isScratchpad: params.isScratchpad,
    retainFromEventId: params.retainFromEventId,
  };
}
