/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event as AdkEvent,
  createEvent,
  createSession,
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_SUCCESS_RESULT,
  getFunctionResponses,
  InvocationContext,
  PluginManager,
  Session,
} from '@google/adk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z} from 'zod/v4';
import {
  createEndOfAgentEvent,
  createFinishTaskFailureEvent,
  createTaskFailureEvents,
  findFinishTaskArgsFromHistory,
  textFromContent,
} from '../../src/a2a/a2a_remote_agent_task.js';
import {
  getOutputWrapperKey,
  isFinishTaskTerminalFr,
} from '../../src/tools/finish_task_tool.js';

function ctxFor(events: AdkEvent[] = [], isolationScope?: string) {
  return new InvocationContext({
    invocationId: 'inv-1',
    branch: 'root.peer',
    isolationScope,
    pluginManager: new PluginManager([]),
    session: createSession({id: 's-1', appName: 'app-1', events}),
  });
}

function finishCall(
  args: Record<string, unknown>,
  options: {id?: string; isolationScope?: string} = {},
): AdkEvent {
  return createEvent({
    author: 'peer_agent',
    isolationScope: options.isolationScope,
    content: {
      role: 'model',
      parts: [{functionCall: {id: options.id, name: 'finish_task', args}}],
    },
  });
}

function finishResponse(result: unknown, id?: string): AdkEvent {
  return createEvent({
    author: 'peer_agent',
    content: {
      role: 'user',
      parts: [
        {functionResponse: {id, name: 'finish_task', response: {result}}},
      ],
    },
  });
}

describe('isFinishTaskTerminalFr', () => {
  it('is true for a successful completion', () => {
    expect(
      isFinishTaskTerminalFr(finishResponse(FINISH_TASK_SUCCESS_RESULT)),
    ).toBe(true);
  });

  it('is true for a reported failure', () => {
    expect(
      isFinishTaskTerminalFr(finishResponse(FINISH_TASK_ERROR_RESULT)),
    ).toBe(true);
  });

  it('is false for a validation error, so the agent can retry', () => {
    expect(
      isFinishTaskTerminalFr(finishResponse({error: 'missing parameters'})),
    ).toBe(false);
  });

  it('is false for a response from another tool', () => {
    const event = createEvent({
      author: 'peer_agent',
      content: {
        role: 'user',
        parts: [
          {functionResponse: {name: 'lookup', response: {result: 'anything'}}},
        ],
      },
    });

    expect(isFinishTaskTerminalFr(event)).toBe(false);
  });

  it('is false for an event with no function response', () => {
    expect(isFinishTaskTerminalFr(createEvent({author: 'peer_agent'}))).toBe(
      false,
    );
  });
});

describe('getOutputWrapperKey', () => {
  it('is undefined for an object schema', () => {
    expect(
      getOutputWrapperKey({
        type: Type.OBJECT,
        properties: {a: {type: Type.STRING}},
      }),
    ).toBeUndefined();
  });

  it('is undefined when no schema is declared', () => {
    expect(getOutputWrapperKey()).toBeUndefined();
  });

  it('wraps a primitive schema under result', () => {
    expect(getOutputWrapperKey({type: Type.STRING})).toBe('result');
  });

  it('wraps an array schema under result', () => {
    expect(
      getOutputWrapperKey({type: Type.ARRAY, items: {type: Type.STRING}}),
    ).toBe('result');
  });

  it('reads a zod object schema as an object', () => {
    expect(getOutputWrapperKey(z.object({a: z.string()}))).toBeUndefined();
  });
});

describe('findFinishTaskArgsFromHistory', () => {
  function sessionOf(events: AdkEvent[]): Session {
    return createSession({id: 's-1', appName: 'app-1', events});
  }

  it('returns the newest call when nothing narrows the search', () => {
    const session = sessionOf([finishCall({n: 1}), finishCall({n: 2})]);

    expect(findFinishTaskArgsFromHistory(session)).toEqual({n: 2});
  });

  it('returns undefined when the session holds no finish_task call', () => {
    expect(findFinishTaskArgsFromHistory(sessionOf([]))).toBeUndefined();
  });

  it('ignores calls outside the isolation scope', () => {
    const session = sessionOf([
      finishCall({n: 1}, {isolationScope: 'mine'}),
      finishCall({n: 2}, {isolationScope: 'someone-else'}),
    ]);

    expect(findFinishTaskArgsFromHistory(session, 'mine')).toEqual({n: 1});
  });

  it('matches the call the terminal response answers', () => {
    const session = sessionOf([
      finishCall({n: 1}, {id: 'call-a'}),
      finishCall({n: 2}, {id: 'call-b'}),
    ]);

    expect(
      findFinishTaskArgsFromHistory(
        session,
        undefined,
        finishResponse(FINISH_TASK_SUCCESS_RESULT, 'call-a'),
      ),
    ).toEqual({n: 1});
  });

  it('returns undefined when no call matches the response id', () => {
    const session = sessionOf([finishCall({n: 1}, {id: 'call-a'})]);

    expect(
      findFinishTaskArgsFromHistory(
        session,
        undefined,
        finishResponse(FINISH_TASK_SUCCESS_RESULT, 'call-z'),
      ),
    ).toBeUndefined();
  });

  it('skips a call from another tool', () => {
    const other = createEvent({
      author: 'peer_agent',
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'x', name: 'lookup', args: {n: 9}}}],
      },
    });

    expect(
      findFinishTaskArgsFromHistory(sessionOf([finishCall({n: 1}), other])),
    ).toEqual({n: 1});
  });
});

describe('textFromContent', () => {
  it('joins the text parts', () => {
    expect(
      textFromContent({role: 'model', parts: [{text: 'a'}, {text: 'b'}]}),
    ).toBe('a\nb');
  });

  it('is undefined for content with no text', () => {
    expect(textFromContent(undefined)).toBeUndefined();
    expect(textFromContent({role: 'model'})).toBeUndefined();
    expect(
      textFromContent({role: 'model', parts: [{thought: true}]}),
    ).toBeUndefined();
  });
});

describe('createFinishTaskFailureEvent', () => {
  it('writes the failure result the coordinator reads', () => {
    const event = createFinishTaskFailureEvent(
      ctxFor([], 'scope-1'),
      'peer_agent',
      'it broke',
    );

    expect(getFunctionResponses(event)[0].response).toEqual({
      result: FINISH_TASK_ERROR_RESULT,
    });
    expect(event.errorMessage).toBe('it broke');
    expect(event.isolationScope).toBe('scope-1');
    expect(event.branch).toBe('root.peer');
  });
});

describe('createTaskFailureEvents', () => {
  it('reports the error then releases the task', () => {
    const [errorEvent, finishEvent] = createTaskFailureEvents({
      errorText: 'the kitchen is closed',
      ctx: ctxFor([], 'scope-1'),
      agentName: 'peer_agent',
      taskId: 'task-9',
    });

    expect(errorEvent.errorMessage).toBe(
      'Remote A2A task failed: the kitchen is closed',
    );
    expect(errorEvent.customMetadata).toEqual({
      'a2a:error': 'Remote A2A task failed: the kitchen is closed',
      'a2a:task_id': 'task-9',
    });
    expect(getFunctionResponses(finishEvent)[0].response).toEqual({
      result: FINISH_TASK_ERROR_RESULT,
    });
  });

  it('records the request when one is supplied', () => {
    const [errorEvent] = createTaskFailureEvents({
      errorText: 'boom',
      ctx: ctxFor(),
      agentName: 'peer_agent',
      taskId: 'task-9',
      request: {
        kind: 'message',
        messageId: 'm-1',
        role: 'user',
        parts: [{kind: 'text', text: 'do it'}],
      },
    });

    expect(errorEvent.customMetadata?.['a2a:request']).toMatchObject({
      messageId: 'm-1',
    });
  });
});

describe('createEndOfAgentEvent', () => {
  it('marks the end of the agent', () => {
    const event = createEndOfAgentEvent(ctxFor([], 'scope-1'), 'peer_agent');

    expect(event.actions.endOfAgent).toBe(true);
    expect(event.author).toBe('peer_agent');
    expect(event.isolationScope).toBe('scope-1');
  });
});
