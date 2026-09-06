/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {cloneDeep} from 'lodash-es';
import {describe, expect, it} from 'vitest';
import {createEvent, Event} from '../../src/events/event.js';
import {applyRewinds} from '../../src/events/rewind_events.js';

function turnEvent(invocationId: string, text: string): Event {
  return createEvent({
    invocationId,
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

function rewindMarker(invocationId: string, target: string): Event {
  return createEvent({
    invocationId,
    author: 'user',
    actions: {rewindBeforeInvocationId: target},
  });
}

function texts(events: Event[]): Array<string | undefined> {
  return events.map((event) => event.content?.parts?.[0]?.text);
}

describe('applyRewinds', () => {
  it('keeps every event when no marker is present', () => {
    const events = [
      turnEvent('inv1', 'one'),
      turnEvent('inv2', 'two'),
      turnEvent('inv3', 'three'),
    ];

    expect(applyRewinds(events)).toEqual(events);
  });

  it('drops the marker and every event back to the target invocation', () => {
    const events = [
      turnEvent('inv1', 'user one'),
      turnEvent('inv1', 'model one'),
      turnEvent('inv2', 'user two'),
      turnEvent('inv2', 'model two'),
      rewindMarker('inv3', 'inv2'),
      turnEvent('inv3', 'user three'),
    ];

    expect(texts(applyRewinds(events))).toEqual([
      'user one',
      'model one',
      'user three',
    ]);
  });

  it('resolves the earlier marker after the later one', () => {
    const events = [
      turnEvent('inv1', 'one'),
      turnEvent('inv2', 'two'),
      rewindMarker('inv2', 'inv2'),
      turnEvent('inv3', 'three'),
      rewindMarker('inv4', 'inv3'),
      turnEvent('inv5', 'five'),
    ];

    expect(texts(applyRewinds(events))).toEqual(['one', 'five']);
  });

  it('drops only the marker when the target invocation is absent', () => {
    const events = [
      turnEvent('inv1', 'one'),
      turnEvent('inv2', 'two'),
      rewindMarker('inv3', 'inv-missing'),
      turnEvent('inv3', 'three'),
    ];

    expect(texts(applyRewinds(events))).toEqual(['one', 'two', 'three']);
  });

  it('returns nothing when the target invocation starts the history', () => {
    const events = [
      turnEvent('inv1', 'one'),
      turnEvent('inv1', 'two'),
      rewindMarker('inv2', 'inv1'),
    ];

    expect(applyRewinds(events)).toEqual([]);
  });

  it('ignores a marker that targets its own first event', () => {
    const events = [rewindMarker('inv1', 'inv1'), turnEvent('inv2', 'two')];

    expect(texts(applyRewinds(events))).toEqual(['two']);
  });

  it('leaves the input array and its events untouched', () => {
    const events = [
      turnEvent('inv1', 'one'),
      turnEvent('inv2', 'two'),
      rewindMarker('inv3', 'inv2'),
    ];
    const before = cloneDeep(events);

    applyRewinds(events);

    expect(events).toEqual(before);
  });
});
