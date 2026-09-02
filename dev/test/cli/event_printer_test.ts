/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Event} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {toJsonlRecord} from '../../src/cli/event_printer.js';

function buildEvent(overrides: Partial<Event> = {}): Event {
  return {...createEvent({author: 'model', id: 'event-1'}), ...overrides};
}

describe('toJsonlRecord', () => {
  it('drops actions once every sub-object is empty', () => {
    const record = toJsonlRecord(buildEvent());

    expect(record).not.toHaveProperty('actions');
  });

  it('keeps the sub-objects of actions that carry something', () => {
    const record = toJsonlRecord(
      buildEvent({
        actions: {
          ...createEvent().actions,
          stateDelta: {city: 'Boston'},
        },
      }),
    );

    expect(record['actions']).toEqual({stateDelta: {city: 'Boston'}});
  });

  it('adds the node path of a workflow event', () => {
    const record = toJsonlRecord(buildEvent({nodeInfo: {path: 'root/child'}}));

    expect(record['node_path']).toBe('root/child');
  });

  it('omits the session id when there is none', () => {
    expect(toJsonlRecord(buildEvent())).not.toHaveProperty('session_id');
  });

  it('leads with author, session id, node path and id', () => {
    const record = toJsonlRecord(
      buildEvent({
        content: {parts: [{text: 'hi'}]},
        nodeInfo: {path: 'root'},
      }),
      'session-123',
    );

    expect(Object.keys(record).slice(0, 4)).toEqual([
      'author',
      'session_id',
      'node_path',
      'id',
    ]);
  });

  it('leaves out the fields that were undefined', () => {
    const record = toJsonlRecord(buildEvent());

    expect(record).not.toHaveProperty('content');
    expect(record).not.toHaveProperty('errorCode');
  });
});
