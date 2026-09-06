/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, createEventActions} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {normalizeEvent} from '../../src/integration/test_runner.js';

describe('normalizeEvent', () => {
  it('strips the per-run event identity fields', () => {
    const normalized = normalizeEvent(
      createEvent({
        id: 'evt-1',
        invocationId: 'inv-1',
        timestamp: 123,
        author: 'agent',
        longRunningToolIds: ['tool-1'],
        content: {role: 'model', parts: [{text: 'hi'}]},
      }),
    );

    expect(Object.keys(normalized).sort()).toEqual(['author', 'content']);
    expect(normalized.content).toEqual({role: 'model', parts: [{text: 'hi'}]});
  });

  it('strips the nondeterministic part fields', () => {
    const normalized = normalizeEvent(
      createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [
            {
              text: 'hi',
              thought: true,
              thoughtSignature: 'sig',
              functionCall: {id: 'fc-1', name: 'roll', args: {sides: 6}},
              functionResponse: {
                id: 'fc-1',
                name: 'roll',
                response: {result: 4},
              },
            },
          ],
        },
      }),
    );

    expect(normalized.content?.parts).toEqual([{text: 'hi', thought: true}]);
  });

  it('keeps user state but drops replay bookkeeping keys', () => {
    const normalized = normalizeEvent(
      createEvent({
        author: 'agent',
        actions: createEventActions({
          stateDelta: {
            _adk_recordings_config: {a: 1},
            _adk_replay_config: {b: 2},
            userKey: 'v',
          },
        }),
      }),
    );

    expect(normalized.actions).toEqual({stateDelta: {userKey: 'v'}});
  });

  it('prunes an empty parts array', () => {
    const normalized = normalizeEvent(
      createEvent({author: 'agent', content: {role: 'model', parts: []}}),
    );

    expect(normalized.content).toEqual({role: 'model'});
  });

  it('tolerates actions that carry no stateDelta', () => {
    const normalized = normalizeEvent(
      createEvent({
        author: 'agent',
        actions: createEventActions({stateDelta: undefined}),
      }),
    );

    expect(Object.keys(normalized)).toEqual(['author']);
  });

  it('normalizes two runs that differ only in volatile fields to equal values', () => {
    const first = createEvent({
      id: 'evt-1',
      invocationId: 'inv-1',
      timestamp: 1,
      author: 'agent',
      content: {
        role: 'model',
        parts: [{text: 'hi', thoughtSignature: 'sig-1'}],
      },
    });
    const second = createEvent({
      id: 'evt-2',
      invocationId: 'inv-2',
      timestamp: 2,
      author: 'agent',
      content: {
        role: 'model',
        parts: [{text: 'hi', thoughtSignature: 'sig-2'}],
      },
    });

    expect(normalizeEvent(first)).toEqual(normalizeEvent(second));
  });
});
