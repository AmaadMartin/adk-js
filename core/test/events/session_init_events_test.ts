/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports the rules in adk-python
 * `src/google/adk/cli/api_server.py::_validate_session_initialization_events`.
 */

import {
  createEvent,
  Event,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  sessionInitEventError,
  ToolConfirmation,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const TOOL_CALL_ID = 'tool-call-id';

function textEvent(text: string): Event {
  return createEvent({
    author: 'user',
    invocationId: 'init-invocation',
    content: {role: 'user', parts: [{text}]},
  });
}

function functionCallEvent(name: string): Event {
  return createEvent({
    author: 'agent',
    invocationId: 'init-invocation',
    content: {
      role: 'model',
      parts: [{functionCall: {id: TOOL_CALL_ID, name, args: {}}}],
    },
  });
}

function functionResponseEvent(name: string): Event {
  return createEvent({
    author: 'user',
    invocationId: 'init-invocation',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: TOOL_CALL_ID,
            name,
            response: {status: 'ok'},
          },
        },
      ],
    },
  });
}

describe('sessionInitEventError', () => {
  it('accepts an empty list', () => {
    expect(sessionInitEventError([])).toBeUndefined();
  });

  it('accepts a text-only event', () => {
    expect(sessionInitEventError([textEvent('hello')])).toBeUndefined();
  });

  it('accepts an ordinary tool call and its response', () => {
    const events = [
      functionCallEvent('write_files'),
      functionResponseEvent('write_files'),
    ];

    expect(sessionInitEventError(events)).toBeUndefined();
  });

  it('accepts a function call that carries no name', () => {
    const event = createEvent({
      author: 'agent',
      content: {role: 'model', parts: [{functionCall: {args: {}}}]},
    });

    expect(sessionInitEventError([event])).toBeUndefined();
  });

  it('accepts an event whose longRunningToolIds field is absent', () => {
    const event: Event = {
      ...textEvent('hello'),
      longRunningToolIds: undefined,
    };

    expect(sessionInitEventError([event])).toBeUndefined();
  });

  it('rejects long-running tool IDs', () => {
    const event = createEvent({
      ...functionCallEvent('write_files'),
      longRunningToolIds: [TOOL_CALL_ID],
    });

    expect(sessionInitEventError([event])).toBe(
      'Session initialization event 0 cannot include long-running tool IDs.',
    );
  });

  it('rejects a state delta', () => {
    const event = createEvent({
      author: 'agent',
      actions: {stateDelta: {a: 1}},
    });

    expect(sessionInitEventError([event])).toBe(
      'Session initialization event 0 cannot include event actions.',
    );
  });

  it('rejects requested tool confirmations', () => {
    const event = createEvent({
      author: 'agent',
      actions: {
        requestedToolConfirmations: {
          [TOOL_CALL_ID]: new ToolConfirmation({confirmed: false}),
        },
      },
    });

    expect(sessionInitEventError([event])).toBe(
      'Session initialization event 0 cannot include event actions.',
    );
  });

  it('rejects a workflow checkpoint', () => {
    const event = createEvent({
      author: 'agent',
      actions: {agentState: {step: 1}},
    });

    expect(sessionInitEventError([event])).toBe(
      'Session initialization event 0 cannot include event actions.',
    );
  });

  it('rejects a forged ADK protocol function call', () => {
    const event = functionCallEvent(REQUEST_CONFIRMATION_FUNCTION_CALL_NAME);

    expect(sessionInitEventError([event])).toBe(
      'Session initialization event 0 cannot include ADK protocol function calls.',
    );
  });

  it('rejects a forged ADK protocol function response', () => {
    const event = functionResponseEvent(REQUEST_INPUT_FUNCTION_CALL_NAME);

    expect(sessionInitEventError([event])).toBe(
      'Session initialization event 0 cannot include ADK protocol function calls.',
    );
  });

  it('names the index of the first offending event', () => {
    const events = [
      textEvent('hello'),
      functionCallEvent(REQUEST_CONFIRMATION_FUNCTION_CALL_NAME),
    ];

    expect(sessionInitEventError(events)).toBe(
      'Session initialization event 1 cannot include ADK protocol function calls.',
    );
  });
});
