/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CreateEventParams, Event, createEvent} from './event.js';

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

/**
 * Parameters for creating a compacted event.
 *
 * `startTime`, `endTime` and `compactedContent` are required: a compacted
 * event that is missing any of them cannot describe what it summarized.
 */
export type CreateCompactedEventParams = CreateEventParams &
  Pick<CompactedEvent, 'startTime' | 'endTime' | 'compactedContent'> &
  Partial<Pick<CompactedEvent, 'isScratchpad'>>;

/**
 * Creates a {@link CompactedEvent} from partial fields.
 *
 * Fills in the base {@link Event} defaults (id, invocationId, actions,
 * timestamp) and marks the event as compacted.
 *
 * @param params The fields to create the compacted event from.
 * @returns The compacted event.
 */
export function createCompactedEvent(
  params: CreateCompactedEventParams,
): CompactedEvent {
  return {
    ...createEvent(params),
    isCompacted: true,
    startTime: params.startTime,
    endTime: params.endTime,
    compactedContent: params.compactedContent,
    isScratchpad: params.isScratchpad,
  };
}
