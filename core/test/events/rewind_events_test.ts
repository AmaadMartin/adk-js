/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {createEventActions} from '../../src/events/event_actions.js';
import {applyRewinds} from '../../src/events/rewind_events.js';

function turn(invocationId: string, text: string): Event {
  return createEvent({
    author: 'user',
    invocationId,
    content: {role: 'user', parts: [{text}]},
  });
}

function rewindMarker(invocationId: string, target: string): Event {
  return createEvent({
    author: 'user',
    invocationId,
    actions: createEventActions({rewindBeforeInvocationId: target}),
  });
}

function textsOf(events: Event[]): string[] {
  return events.map((event) => event.content?.parts?.[0]?.text ?? '');
}

describe('applyRewinds', () => {
  it('returns the history unchanged when no marker is present', () => {
    const events = [turn('inv-1', 'first'), turn('inv-2', 'second')];

    expect(applyRewinds(events)).toEqual(events);
  });

  it('returns an empty list for an empty history', () => {
    expect(applyRewinds([])).toEqual([]);
  });

  it('drops the marker and every event back to the target invocation', () => {
    const events = [
      turn('inv-1', 'kept before'),
      turn('inv-2', 'rewound'),
      turn('inv-2', 'rewound too'),
      turn('inv-3', 'also rewound'),
      rewindMarker('inv-4', 'inv-2'),
      turn('inv-5', 'kept after'),
    ];

    expect(textsOf(applyRewinds(events))).toEqual([
      'kept before',
      'kept after',
    ]);
  });

  it('drops only the marker when the target invocation is absent', () => {
    const events = [
      turn('inv-1', 'first'),
      rewindMarker('inv-2', 'inv-missing'),
      turn('inv-3', 'last'),
    ];

    expect(textsOf(applyRewinds(events))).toEqual(['first', 'last']);
  });

  it('drops only the marker when the target invocation starts later', () => {
    const events = [
      turn('inv-1', 'first'),
      rewindMarker('inv-2', 'inv-3'),
      turn('inv-3', 'last'),
    ];

    expect(textsOf(applyRewinds(events))).toEqual(['first', 'last']);
  });

  it('resolves two stacked markers', () => {
    const events = [
      turn('inv-1', 'kept'),
      turn('inv-2', 'rewound once'),
      rewindMarker('inv-3', 'inv-2'),
      turn('inv-4', 'rewound twice'),
      rewindMarker('inv-5', 'inv-4'),
      turn('inv-6', 'kept after'),
    ];

    expect(textsOf(applyRewinds(events))).toEqual(['kept', 'kept after']);
  });

  it('rewinds to the earliest event of the target invocation', () => {
    const events = [
      turn('inv-1', 'first of target'),
      turn('inv-1', 'second of target'),
      rewindMarker('inv-2', 'inv-1'),
    ];

    expect(applyRewinds(events)).toEqual([]);
  });

  it('does not mutate the input array or its events', () => {
    const events = [
      turn('inv-1', 'kept'),
      turn('inv-2', 'rewound'),
      rewindMarker('inv-3', 'inv-2'),
    ];
    const snapshot = [...events];

    applyRewinds(events);

    expect(events).toEqual(snapshot);
    expect(events[1].content?.parts?.[0]?.text).toBe('rewound');
  });

  it('returns the surviving event references themselves', () => {
    const kept = turn('inv-1', 'kept');
    const events = [kept, turn('inv-2', 'rewound'), rewindMarker('i', 'inv-2')];

    expect(applyRewinds(events)[0]).toBe(kept);
  });
});
