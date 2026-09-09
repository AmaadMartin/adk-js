/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createSession,
  Event,
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
  Session,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {findActiveTaskScope} from '../../src/runner/task_scope_utils.js';

function scopedEvent(params: {
  isolationScope?: string;
  invocationId: string;
  author?: string;
  text?: string;
}): Event {
  const event = createEvent({
    invocationId: params.invocationId,
    author: params.author ?? 'task_agent',
    content: {role: 'model', parts: [{text: params.text ?? 'working'}]},
  });
  event.isolationScope = params.isolationScope;
  return event;
}

function finishTaskResponse(params: {
  isolationScope: string;
  invocationId: string;
  response: Record<string, unknown>;
  name?: string;
}): Event {
  const event = createEvent({
    invocationId: params.invocationId,
    author: 'task_agent',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'fr-1',
            name: params.name ?? FINISH_TASK_TOOL_NAME,
            response: params.response,
          },
        },
      ],
    },
  });
  event.isolationScope = params.isolationScope;
  return event;
}

function sessionOf(events: Event[]): Session {
  return createSession({id: 's1', appName: 'app', userId: 'u', events});
}

describe('findActiveTaskScope', () => {
  it('returns the scope and invocation of a task paused on a non-terminal error', () => {
    const session = sessionOf([
      scopedEvent({isolationScope: 'fc-1', invocationId: 'inv-1'}),
      finishTaskResponse({
        isolationScope: 'fc-1',
        invocationId: 'inv-1',
        response: {error: 'missing required parameters: city'},
      }),
    ]);

    expect(findActiveTaskScope(session)).toEqual({
      isolationScope: 'fc-1',
      invocationId: 'inv-1',
    });
  });

  it('returns undefined once the scope closed with the success sentinel', () => {
    const session = sessionOf([
      scopedEvent({isolationScope: 'fc-1', invocationId: 'inv-1'}),
      finishTaskResponse({
        isolationScope: 'fc-1',
        invocationId: 'inv-1',
        response: {result: FINISH_TASK_SUCCESS_RESULT},
      }),
    ]);

    expect(findActiveTaskScope(session)).toBeUndefined();
  });

  it('returns undefined once the scope closed with the error sentinel', () => {
    const session = sessionOf([
      scopedEvent({isolationScope: 'fc-1', invocationId: 'inv-1'}),
      finishTaskResponse({
        isolationScope: 'fc-1',
        invocationId: 'inv-1',
        response: {result: FINISH_TASK_ERROR_RESULT},
      }),
    ]);

    expect(findActiveTaskScope(session)).toBeUndefined();
  });

  it('keeps a scope closed when later events arrive inside it', () => {
    const session = sessionOf([
      scopedEvent({isolationScope: 'fc-1', invocationId: 'inv-1'}),
      finishTaskResponse({
        isolationScope: 'fc-1',
        invocationId: 'inv-1',
        response: {result: FINISH_TASK_SUCCESS_RESULT},
      }),
      scopedEvent({
        isolationScope: 'fc-1',
        invocationId: 'inv-1',
        text: 'summary of the finished task',
      }),
    ]);

    expect(findActiveTaskScope(session)).toBeUndefined();
  });

  it('ignores a function response from a tool other than finish_task', () => {
    const session = sessionOf([
      finishTaskResponse({
        isolationScope: 'fc-1',
        invocationId: 'inv-1',
        name: 'book_flight',
        response: {result: FINISH_TASK_SUCCESS_RESULT},
      }),
    ]);

    expect(findActiveTaskScope(session)).toEqual({
      isolationScope: 'fc-1',
      invocationId: 'inv-1',
    });
  });

  it('returns undefined when no event carries a scope', () => {
    const session = sessionOf([
      createEvent({
        invocationId: 'inv-1',
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      }),
      scopedEvent({invocationId: 'inv-1', author: 'coordinator'}),
    ]);

    expect(findActiveTaskScope(session)).toBeUndefined();
  });

  it('returns undefined for a session with no events', () => {
    expect(findActiveTaskScope(sessionOf([]))).toBeUndefined();
  });

  it('picks the newest of two open scopes', () => {
    const session = sessionOf([
      scopedEvent({isolationScope: 'fc-1', invocationId: 'inv-1'}),
      scopedEvent({isolationScope: 'fc-2', invocationId: 'inv-2'}),
    ]);

    expect(findActiveTaskScope(session)).toEqual({
      isolationScope: 'fc-2',
      invocationId: 'inv-2',
    });
  });

  it('skips a closed newer scope and returns the still-open older one', () => {
    const session = sessionOf([
      scopedEvent({isolationScope: 'fc-1', invocationId: 'inv-1'}),
      scopedEvent({isolationScope: 'fc-2', invocationId: 'inv-2'}),
      finishTaskResponse({
        isolationScope: 'fc-2',
        invocationId: 'inv-2',
        response: {result: FINISH_TASK_SUCCESS_RESULT},
      }),
    ]);

    expect(findActiveTaskScope(session)).toEqual({
      isolationScope: 'fc-1',
      invocationId: 'inv-1',
    });
  });
});
