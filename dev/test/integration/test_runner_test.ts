/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createEventActions,
  Event,
  InMemorySessionService,
} from '@google/adk';
import * as assert from 'node:assert';
import {describe, expect, it} from 'vitest';
import {normalizeEvent} from '../../src/integration/test_runner.js';

/**
 * A recorded event as the conformance YAML loader produces it: a plain object
 * literal, never `createEvent`, so it cannot carry the event signature brand.
 */
function recordedEvent(): Event {
  return {
    id: '',
    invocationId: '',
    timestamp: 0,
    actions: createEventActions(),
    author: 'agent',
    content: {role: 'model', parts: [{text: 'hello'}]},
  };
}

describe('normalizeEvent', () => {
  it('compares equal to an unbranded recorded event', () => {
    const replayed = createEvent({
      author: 'agent',
      content: {role: 'model', parts: [{text: 'hello'}]},
    });

    assert.deepStrictEqual(
      normalizeEvent(replayed),
      normalizeEvent(recordedEvent()),
    );
  });

  it('removes the event signature brand', () => {
    const replayed = createEvent({author: 'agent'});

    expect(Object.getOwnPropertySymbols(normalizeEvent(replayed))).toEqual([]);
  });

  it('compares equal after a round trip through the session service', async () => {
    const sessionService = new InMemorySessionService();
    const request = {appName: 'test-runner', userId: 'u', sessionId: 's'};
    const session = await sessionService.createSession(request);
    await sessionService.appendEvent({
      session,
      event: createEvent({
        author: 'agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      }),
    });
    const stored = await sessionService.getSession(request);
    if (!stored) {
      expect.fail('the session service dropped the session it just created');
    }

    assert.deepStrictEqual(
      normalizeEvent(stored.events[0]),
      normalizeEvent(recordedEvent()),
    );
  });
});
