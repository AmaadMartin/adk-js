/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  createEvent,
  createEventActions,
  Event,
  generateClientFunctionCallId,
  ToolConfirmation,
} from '@google/adk';
import * as assert from 'node:assert';
import {describe, expect, it} from 'vitest';
import {normalizeEvent} from '../../src/integration/test_runner.js';

const AUTH_CONFIG: AuthConfig = {
  credentialKey: 'testKey',
  authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
};

function toolCallEvent(
  id: string,
  name: string,
  args: Record<string, unknown>,
): Event {
  return createEvent({
    author: 'agent',
    content: {role: 'model', parts: [{functionCall: {id, name, args}}]},
  });
}

function toolResponseEvent(
  id: string,
  name: string,
  response: Record<string, unknown>,
): Event {
  return createEvent({
    author: 'user',
    content: {role: 'user', parts: [{functionResponse: {id, name, response}}]},
  });
}

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

    expect(normalized.content?.parts).toEqual([
      {
        text: 'hi',
        thought: true,
        functionCall: {name: 'roll', args: {sides: 6}},
        functionResponse: {name: 'roll', response: {result: 4}},
      },
    ]);
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

  it('drops the requested auth configs and tool confirmations', () => {
    const normalized = normalizeEvent(
      createEvent({
        author: 'agent',
        actions: createEventActions({
          requestedAuthConfigs: {'fc-1': AUTH_CONFIG},
          requestedToolConfirmations: {
            'fc-1': new ToolConfirmation({hint: 'ok?', confirmed: false}),
          },
          stateDelta: {userKey: 'v'},
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

  it('tolerates an event that carries no actions at all', () => {
    // A golden session is `camelcaseKeys(yaml.load(...)) as Session`, so an
    // event parsed out of generated-session.yaml can be missing `actions` even
    // though the type declares it.
    const event = createEvent({author: 'agent'});
    const parsedFromYaml: Partial<Event> = event;
    delete parsedFromYaml.actions;

    expect(Object.keys(normalizeEvent(event))).toEqual(['author']);
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

  describe('tool traffic', () => {
    it('keeps the tool call name and args and strips only its id', () => {
      const event = toolCallEvent('adk-1111', 'roll_die', {sides: 6});

      const normalized = normalizeEvent(event);

      expect(normalized.content?.parts).toEqual([
        {functionCall: {name: 'roll_die', args: {sides: 6}}},
      ]);
      expect(normalized.content?.parts?.[0].functionCall).not.toHaveProperty(
        'id',
      );
      // normalizeEvent filters in place, so the caller's event is rewritten too.
      expect(event.content?.parts?.[0].functionCall).not.toHaveProperty('id');
    });

    it('keeps the tool result name and response and strips only its id', () => {
      const normalized = normalizeEvent(
        toolResponseEvent('adk-1111', 'roll_die', {result: 4}),
      );

      expect(normalized.content?.parts).toEqual([
        {functionResponse: {name: 'roll_die', response: {result: 4}}},
      ]);
      expect(
        normalized.content?.parts?.[0].functionResponse,
      ).not.toHaveProperty('id');
    });

    it('treats two runs with freshly generated call ids as equal', () => {
      const first = generateClientFunctionCallId();
      const second = generateClientFunctionCallId();
      expect(first).not.toEqual(second);

      assert.deepStrictEqual(
        normalizeEvent(toolCallEvent(first, 'roll_die', {sides: 6})),
        normalizeEvent(toolCallEvent(second, 'roll_die', {sides: 6})),
      );
    });

    it('detects a differing tool name', () => {
      expect(() =>
        assert.deepStrictEqual(
          normalizeEvent(toolCallEvent('adk-1', 'roll_die', {sides: 6})),
          normalizeEvent(toolCallEvent('adk-2', 'check_prime', {sides: 6})),
        ),
      ).toThrow(assert.AssertionError);
    });

    it('detects differing tool args', () => {
      expect(() =>
        assert.deepStrictEqual(
          normalizeEvent(toolCallEvent('adk-1', 'roll_die', {sides: 6})),
          normalizeEvent(toolCallEvent('adk-2', 'roll_die', {sides: 20})),
        ),
      ).toThrow(assert.AssertionError);
    });

    it('detects a differing tool result', () => {
      expect(() =>
        assert.deepStrictEqual(
          normalizeEvent(toolResponseEvent('adk-1', 'roll_die', {result: 4})),
          normalizeEvent(toolResponseEvent('adk-2', 'roll_die', {result: 5})),
        ),
      ).toThrow(assert.AssertionError);
    });

    it('normalizes a text, a call and a result part in one pass', () => {
      const normalized = normalizeEvent(
        createEvent({
          author: 'agent',
          content: {
            role: 'model',
            parts: [
              {text: 'rolling', thoughtSignature: 'sig'},
              {functionCall: {id: 'adk-1', name: 'roll_die', args: {sides: 6}}},
              {
                functionResponse: {
                  id: 'adk-1',
                  name: 'roll_die',
                  response: {result: 4},
                },
              },
            ],
          },
        }),
      );

      expect(normalized.content?.parts).toEqual([
        {text: 'rolling'},
        {functionCall: {name: 'roll_die', args: {sides: 6}}},
        {functionResponse: {name: 'roll_die', response: {result: 4}}},
      ]);
    });

    it('drops a tool result that carried nothing but an id', () => {
      const normalized = normalizeEvent(
        createEvent({
          author: 'agent',
          content: {role: 'user', parts: [{functionResponse: {id: 'adk-1'}}]},
        }),
      );

      // The emptied functionResponse is pruned; the part itself survives
      // because the pruner only drops empty objects held under a key, not
      // empty array elements. Both sides of a replay are normalized the same
      // way, so the leftover empty part still compares equal.
      expect(normalized.content?.parts).toEqual([{}]);
    });
  });
});
