/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart, Message, Task} from '@a2a-js/sdk';
import {RequestContext, ServerCallContext} from '@a2a-js/sdk/server';
import {convertA2aRequestToAgentRunRequest, getUserId} from '@google/adk';
import {Part as GenAIPart} from '@google/genai';
import {describe, expect, it} from 'vitest';

const DEFAULT_MESSAGE: Message = {
  kind: 'message',
  messageId: 'message-1',
  role: 'user',
  parts: [{kind: 'text', text: 'hello'}],
};

function createRequestContext({
  userMessage = DEFAULT_MESSAGE,
  taskId = 'task-1',
  contextId = 'context-1',
  task,
  context,
}: {
  userMessage?: Message;
  taskId?: string;
  contextId?: string;
  task?: Task;
  context?: ServerCallContext;
} = {}): RequestContext {
  return new RequestContext(
    userMessage,
    taskId,
    contextId,
    task,
    undefined,
    context,
  );
}

/**
 * A request the SDK's own type forbids: `userMessage` is required there, and
 * the guard under test exists for the context that arrives without one.
 */
function createMessagelessRequestContext(): RequestContext {
  return new RequestContext(
    undefined as unknown as Message,
    'task-1',
    'context-1',
  );
}

describe('getUserId', () => {
  it('uses the authenticated principal from the call context', () => {
    const request = createRequestContext({
      context: new ServerCallContext(undefined, {
        isAuthenticated: true,
        userName: 'alice@example.com',
      }),
    });

    expect(getUserId(request)).toBe('alice@example.com');
  });

  it('falls back to the context id when there is no call context', () => {
    expect(getUserId(createRequestContext())).toBe('A2A_USER_context-1');
  });

  it('falls back to the context id when the user has no name', () => {
    const request = createRequestContext({
      context: new ServerCallContext(undefined, {
        isAuthenticated: false,
        userName: '',
      }),
    });

    expect(getUserId(request)).toBe('A2A_USER_context-1');
  });
});

describe('convertA2aRequestToAgentRunRequest', () => {
  it('derives the user id, session id and message', () => {
    const runRequest = convertA2aRequestToAgentRunRequest(
      createRequestContext(),
    );

    expect(runRequest.userId).toBe('A2A_USER_context-1');
    expect(runRequest.sessionId).toBe('context-1');
    expect(runRequest.newMessage.role).toBe('user');
    expect(runRequest.newMessage.parts).toEqual([
      {text: 'hello', thought: false},
    ]);
  });

  it('runs every part through an injected converter', () => {
    const partConverter = (part: A2APart): GenAIPart => ({
      text: `converted:${(part as {text: string}).text}`,
    });

    const runRequest = convertA2aRequestToAgentRunRequest(
      createRequestContext(),
      partConverter,
    );

    expect(runRequest.newMessage.parts).toEqual([{text: 'converted:hello'}]);
  });

  it('expands a part when the converter returns an array', () => {
    const partConverter = (): GenAIPart[] => [{text: 'one'}, {text: 'two'}];

    const runRequest = convertA2aRequestToAgentRunRequest(
      createRequestContext(),
      partConverter,
    );

    expect(runRequest.newMessage.parts).toEqual([{text: 'one'}, {text: 'two'}]);
  });

  it('drops a part when the converter returns undefined', () => {
    const partConverter = (part: A2APart): GenAIPart | undefined =>
      (part as {text: string}).text === 'drop me'
        ? undefined
        : {text: (part as {text: string}).text};
    const request = createRequestContext({
      userMessage: {
        kind: 'message',
        messageId: 'message-1',
        role: 'user',
        parts: [
          {kind: 'text', text: 'drop me'},
          {kind: 'text', text: 'keep me'},
        ],
      },
    });

    const runRequest = convertA2aRequestToAgentRunRequest(
      request,
      partConverter,
    );

    expect(runRequest.newMessage.parts).toEqual([{text: 'keep me'}]);
  });

  it('rejects a request whose parts all convert to nothing', () => {
    // `@google/genai` refuses to build a Content with no parts, so a converter
    // that empties the message fails the run rather than starting an empty one.
    expect(() =>
      convertA2aRequestToAgentRunRequest(createRequestContext(), () => []),
    ).toThrow('empty array');
  });

  it('throws when the request carries no message', () => {
    expect(() =>
      convertA2aRequestToAgentRunRequest(createMessagelessRequestContext()),
    ).toThrow('message not provided');
  });
});
