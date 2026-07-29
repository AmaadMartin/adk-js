/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createEventActions,
  Event,
  ToolConfirmation,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {normalizeEvent} from '../../src/integration/event_filter.js';

function eventWithVolatileFields(): Event {
  return createEvent({
    id: 'event-id',
    invocationId: 'invocation-id',
    timestamp: 1234,
    longRunningToolIds: ['tool-1'],
    author: 'agent',
    content: {role: 'model', parts: [{text: 'hi', thoughtSignature: 'sig'}]},
    actions: createEventActions({
      stateDelta: {_adk_replay_config: {mode: 'replay'}, keep: 'me'},
    }),
  });
}

describe('normalizeEvent', () => {
  it('does not delete fields from the source event', () => {
    const event = eventWithVolatileFields();

    const normalized = normalizeEvent(event);

    expect(normalized).not.toBe(event);
    expect(event.id).toBe('event-id');
    expect(event.invocationId).toBe('invocation-id');
    expect(event.timestamp).toBe(1234);
    expect(event.longRunningToolIds).toEqual(['tool-1']);
    expect(event.content?.parts?.[0].thoughtSignature).toBe('sig');
    expect(event.actions.stateDelta).toEqual({
      _adk_replay_config: {mode: 'replay'},
      keep: 'me',
    });
  });

  it('drops the run specific part fields and keeps the rest', () => {
    const normalized = normalizeEvent(
      createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [
            {
              text: 'hello',
              thought: true,
              inlineData: {data: 'aGVsbG8=', mimeType: 'text/plain'},
              thoughtSignature: 'signature',
              functionCall: {name: 'search', args: {query: 'flights'}},
              functionResponse: {name: 'search', response: {ok: true}},
            },
          ],
        },
      }),
    );

    expect(normalized.content).toStrictEqual({
      role: 'model',
      parts: [
        {
          text: 'hello',
          thought: true,
          inlineData: {data: 'aGVsbG8=', mimeType: 'text/plain'},
        },
      ],
    });
  });

  it('drops the run specific event fields and keeps the rest', () => {
    const normalized = normalizeEvent(
      createEvent({
        id: 'event-id',
        invocationId: 'invocation-id',
        timestamp: 1234,
        longRunningToolIds: ['tool-1'],
        author: 'agent',
        branch: 'parent.child',
        turnComplete: false,
        customMetadata: {trace: 'abc'},
        usageMetadata: {totalTokenCount: 42},
        modelVersion: 'gemini-3-pro',
      }),
    );

    expect(normalized).toStrictEqual({
      author: 'agent',
      branch: 'parent.child',
      turnComplete: false,
      customMetadata: {trace: 'abc'},
      usageMetadata: {totalTokenCount: 42},
      modelVersion: 'gemini-3-pro',
    });
  });

  it('removes the replay plugin state keys', () => {
    const stateDelta = {
      _adk_recordings_config: {path: 'recordings'},
      _adk_replay_config: {mode: 'replay'},
      user: 'kept',
    };

    const normalized = normalizeEvent(
      createEvent({author: 'agent', actions: createEventActions({stateDelta})}),
    );

    expect(normalized.actions.stateDelta).toEqual({user: 'kept'});
  });

  it('drops the requested auth configs and tool confirmations', () => {
    const normalized = normalizeEvent(
      createEvent({
        author: 'agent',
        actions: createEventActions({
          skipSummarization: true,
          stateDelta: {keep: 'me'},
          artifactDelta: {'report.pdf': 2},
          transferToAgent: 'other-agent',
          escalate: true,
          requestedAuthConfigs: {
            call1: {
              authScheme: {type: 'http', scheme: 'bearer'},
              credentialKey: 'credential-key',
            },
          },
          requestedToolConfirmations: {
            call1: new ToolConfirmation({confirmed: false, hint: 'confirm?'}),
          },
        }),
      }),
    );

    expect(normalized.actions).toStrictEqual({
      skipSummarization: true,
      stateDelta: {keep: 'me'},
      artifactDelta: {'report.pdf': 2},
      transferToAgent: 'other-agent',
      escalate: true,
    });
  });

  it('removes unset, null and empty fields', () => {
    const normalized = normalizeEvent(
      createEvent({
        author: 'agent',
        customMetadata: {missing: null, empty: {}, none: [], kept: 'value'},
        content: {
          role: 'model',
          parts: [{text: 'hi', thought: undefined, videoMetadata: {}}],
        },
      }),
    );

    expect(normalized).toStrictEqual({
      author: 'agent',
      customMetadata: {kept: 'value'},
      content: {role: 'model', parts: [{text: 'hi'}]},
    });
  });

  it('handles an event without content', () => {
    expect(normalizeEvent(createEvent({author: 'agent'}))).toStrictEqual({
      author: 'agent',
    });
  });

  it('handles content without parts', () => {
    const normalized = normalizeEvent(
      createEvent({author: 'agent', content: {role: 'user'}}),
    );

    expect(normalized).toStrictEqual({
      author: 'agent',
      content: {role: 'user'},
    });
  });
});
