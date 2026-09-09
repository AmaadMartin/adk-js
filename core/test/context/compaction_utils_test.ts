/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CompactedEvent,
  Event,
  createEvent,
  isScratchpadEvent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  getActiveEvents,
  getActiveEventsSince,
} from '../../src/context/compaction_utils.js';
import {createCompactedEvent} from '../../src/events/compacted_event.js';

function rawEvent(id: string, timestamp: number): Event {
  return createEvent({
    id,
    author: 'user',
    timestamp,
    content: {role: 'user', parts: [{text: id}]},
  });
}

function compactedEvent(
  id: string,
  timestamp: number,
  endTime: number,
  retainFromEventId?: string,
  isScratchpad?: boolean,
): CompactedEvent {
  return createCompactedEvent({
    id,
    author: 'system',
    timestamp,
    startTime: 0,
    endTime,
    compactedContent: `summary ${id}`,
    retainFromEventId,
    isScratchpad,
  });
}

function ids(events: Event[]): string[] {
  return events.map((e) => e.id);
}

describe('getActiveEvents', () => {
  it('retains an event that shares a millisecond with the last compacted event', () => {
    const events: Event[] = [
      rawEvent('r1', 1000),
      rawEvent('r2', 2000),
      compactedEvent('c1', 2500, 2000, 'r3'),
      rawEvent('r3', 2000),
      rawEvent('r4', 3000),
    ];

    expect(ids(getActiveEvents(events))).toEqual(['c1', 'r3', 'r4']);
  });

  it('retains events positioned before a summary that was appended last', () => {
    // The layout a session store keeps: the compacted events stay in place and
    // the summary is appended at the end.
    const events: Event[] = [
      rawEvent('r1', 1000),
      rawEvent('r2', 2000),
      rawEvent('r3', 2000),
      rawEvent('r4', 3000),
      compactedEvent('c1', 3500, 2000, 'r3'),
    ];

    expect(ids(getActiveEvents(events))).toEqual(['c1', 'r3', 'r4']);
  });

  it('returns the input unchanged when no compacted event is present', () => {
    const events: Event[] = [rawEvent('r1', 1000), rawEvent('r2', 2000)];

    expect(getActiveEvents(events)).toBe(events);
  });

  it('drops a same-millisecond event when retainFromEventId is absent, matching the legacy timestamp rule', () => {
    const events: Event[] = [
      rawEvent('r1', 1000),
      rawEvent('r2', 2000),
      compactedEvent('c1', 2500, 2000),
      rawEvent('r3', 2000),
      rawEvent('r4', 3000),
    ];

    expect(ids(getActiveEvents(events))).toEqual(['c1', 'r4']);
  });

  it('falls back to the timestamp rule when retainFromEventId is not in the list', () => {
    const events: Event[] = [
      rawEvent('r1', 1000),
      rawEvent('r2', 2000),
      compactedEvent('c1', 2500, 2000, 'rewritten-by-the-store'),
      rawEvent('r3', 3000),
    ];

    expect(ids(getActiveEvents(events))).toEqual(['c1', 'r3']);
  });

  it('resolves the boundary from the latest compacted event and excludes earlier ones', () => {
    const events: Event[] = [
      rawEvent('r1', 1000),
      compactedEvent('c1', 1500, 1000, 'r2'),
      rawEvent('r2', 2000),
      rawEvent('r3', 2000),
      compactedEvent('c2', 2500, 2000, 'r3'),
      rawEvent('r4', 3000),
    ];

    expect(ids(getActiveEvents(events))).toEqual(['c2', 'r3', 'r4']);
  });

  it('does not mutate the input array', () => {
    const events: Event[] = [
      rawEvent('r1', 1000),
      compactedEvent('c1', 1500, 1000, 'r2'),
      rawEvent('r2', 1000),
    ];

    getActiveEvents(events);

    expect(ids(events)).toEqual(['r1', 'c1', 'r2']);
  });
});

describe('getActiveEventsSince', () => {
  it('anchors on the scratchpad and leaves a plain compacted event active', () => {
    const events: Event[] = [
      rawEvent('r1', 1000),
      compactedEvent('sp', 1500, 1000, 'c1', true),
      compactedEvent('c1', 2000, 1000),
      rawEvent('r2', 1000),
    ];

    expect(ids(getActiveEventsSince(events, isScratchpadEvent))).toEqual([
      'sp',
      'c1',
      'r2',
    ]);
  });

  it('returns the input unchanged when no scratchpad is present', () => {
    const events: Event[] = [
      rawEvent('r1', 1000),
      compactedEvent('c1', 1500, 1000, 'r1'),
    ];

    expect(getActiveEventsSince(events, isScratchpadEvent)).toBe(events);
  });
});
