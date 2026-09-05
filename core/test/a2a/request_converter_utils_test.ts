/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart, Message} from '@a2a-js/sdk';
import {RequestContext, ServerCallContext, User} from '@a2a-js/sdk/server';
import {
  A2A_METADATA_KEY,
  convertA2aRequestToAgentRunRequest,
} from '@google/adk';
import {Part as GenAIPart} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {getUserId} from '../../src/a2a/request_converter_utils.js';

/**
 * A request context carrying request-level metadata, as `@a2a-js/sdk` >= 1.0
 * shapes it. The 0.3.x `RequestContext` class declares no such field, so the
 * fixtures declare it here and `getA2aRequestMetadata` reads it.
 */
interface RequestContextWithMetadata extends RequestContext {
  request?: {metadata?: Record<string, unknown>};
}

/**
 * Builds a fixture whose shape the SDK types forbid. The SDK declares
 * `RequestContext.userMessage`, `RequestContext.contextId` and `User.userName`
 * as always present. A server can omit each of them, which is what the
 * converter's message guard and its user-id fallback handle.
 */
function partialFixture<T>(fields: Partial<T>): T {
  return fields as T;
}

function textPart(text: string): A2APart {
  return {kind: 'text', text};
}

function message(parts: A2APart[], role: 'user' | 'agent' = 'user'): Message {
  return {kind: 'message', messageId: 'message-1', role, parts};
}

function authenticatedUser(userName: string): User {
  return {isAuthenticated: true, userName};
}

function createRequest(
  overrides: Partial<RequestContextWithMetadata> = {},
): RequestContextWithMetadata {
  return {
    userMessage: message([textPart('hello')]),
    taskId: 'test-task',
    contextId: 'test_context',
    ...overrides,
  };
}

describe('getUserId', () => {
  it('returns the authenticated user name from the call context', () => {
    const request = createRequest({
      context: new ServerCallContext(
        undefined,
        authenticatedUser('authenticated_user'),
      ),
    });

    expect(getUserId(request)).toBe('authenticated_user');
  });

  it('derives the user from the context id when there is no call context', () => {
    expect(getUserId(createRequest())).toBe('A2A_USER_test_context');
  });

  it('derives the user from the context id when the call context has no user', () => {
    const request = createRequest({
      context: new ServerCallContext(undefined, undefined),
    });

    expect(getUserId(request)).toBe('A2A_USER_test_context');
  });

  it('derives the user from the context id when the user name is empty', () => {
    const request = createRequest({
      context: new ServerCallContext(undefined, authenticatedUser('')),
    });

    expect(getUserId(request)).toBe('A2A_USER_test_context');
  });

  it('derives the user from the context id when the user name is absent', () => {
    const request = createRequest({
      context: new ServerCallContext(
        undefined,
        partialFixture<User>({isAuthenticated: true}),
      ),
    });

    expect(getUserId(request)).toBe('A2A_USER_test_context');
  });

  it('renders an absent context id in the derived user', () => {
    const request = partialFixture<RequestContext>({
      userMessage: message([textPart('hello')]),
      taskId: 'test-task',
    });

    expect(getUserId(request)).toBe('A2A_USER_undefined');
  });
});

describe('convertA2aRequestToAgentRunRequest', () => {
  it('converts the user, the session, the parts and the metadata', () => {
    const parts = [textPart('test part 1'), textPart('test part 2')];
    const genAiParts: GenAIPart[] = [
      {text: 'test part 1'},
      {text: 'test part 2'},
    ];
    const partConverter = vi
      .fn<(a2aPart: A2APart) => GenAIPart>()
      .mockReturnValueOnce(genAiParts[0])
      .mockReturnValueOnce(genAiParts[1]);
    const request = createRequest({
      userMessage: message(parts),
      contextId: 'test_context_123',
      context: new ServerCallContext(undefined, authenticatedUser('test_user')),
      request: {metadata: {testKey: 'testValue'}},
    });

    const result = convertA2aRequestToAgentRunRequest(request, partConverter);

    expect(result.userId).toBe('test_user');
    expect(result.sessionId).toBe('test_context_123');
    expect(result.newMessage).toEqual({role: 'user', parts: genAiParts});
    expect(result.customMetadata).toEqual({
      a2a_metadata: {testKey: 'testValue'},
    });
    expect(partConverter).toHaveBeenCalledTimes(2);
    expect(partConverter).toHaveBeenNthCalledWith(1, parts[0]);
    expect(partConverter).toHaveBeenNthCalledWith(2, parts[1]);
  });

  it('carries the request metadata under the exported key', () => {
    const request = createRequest({
      request: {metadata: {testKey: 'testValue'}},
    });

    const result = convertA2aRequestToAgentRunRequest(request);

    expect(A2A_METADATA_KEY).toBe('a2a_metadata');
    expect(result.customMetadata?.[A2A_METADATA_KEY]).toEqual({
      testKey: 'testValue',
    });
  });

  it('omits the metadata key when the request carries no metadata', () => {
    const result = convertA2aRequestToAgentRunRequest(createRequest());

    expect(result.customMetadata).toEqual({});
    expect(result.customMetadata).not.toHaveProperty(A2A_METADATA_KEY);
  });

  it('omits the metadata key when the request metadata is empty', () => {
    const request = createRequest({request: {metadata: {}}});

    const result = convertA2aRequestToAgentRunRequest(request);

    expect(result.customMetadata).toEqual({});
  });

  it('rejects a request that carries no message', () => {
    const request = partialFixture<RequestContext>({
      taskId: 'test-task',
      contextId: 'test_context',
    });

    expect(() => convertA2aRequestToAgentRunRequest(request)).toThrow(
      'Request message cannot be None',
    );
  });

  it('accepts a message with no parts', () => {
    const partConverter = vi.fn<(a2aPart: A2APart) => GenAIPart>();
    const request = createRequest({
      userMessage: message([]),
      contextId: 'test_context_123',
    });

    const result = convertA2aRequestToAgentRunRequest(request, partConverter);

    expect(result.newMessage).toEqual({role: 'user', parts: []});
    expect(partConverter).not.toHaveBeenCalled();
    expect(result.userId).toBe('A2A_USER_test_context_123');
  });

  it('leaves the session id absent when the request has no context id', () => {
    const request = partialFixture<RequestContext>({
      userMessage: message([textPart('hello')]),
      taskId: 'test-task',
    });

    const result = convertA2aRequestToAgentRunRequest(request);

    expect(result.sessionId).toBeUndefined();
    expect(result.userId).toBe('A2A_USER_undefined');
  });

  it('derives the user from the context id when the caller is not authenticated', () => {
    const request = createRequest({contextId: 'session_123'});

    const result = convertA2aRequestToAgentRunRequest(request);

    expect(result.userId).toBe('A2A_USER_session_123');
  });

  it('flattens a part converter that returns several parts', () => {
    const partConverter = vi
      .fn<(a2aPart: A2APart) => GenAIPart | GenAIPart[]>()
      .mockReturnValueOnce([{text: 'first'}, {text: 'second'}])
      .mockReturnValueOnce({text: 'third'});
    const request = createRequest({
      userMessage: message([textPart('one'), textPart('two')]),
    });

    const result = convertA2aRequestToAgentRunRequest(request, partConverter);

    expect(result.newMessage?.parts).toEqual([
      {text: 'first'},
      {text: 'second'},
      {text: 'third'},
    ]);
  });

  it('drops a part the converter does not handle', () => {
    const partConverter = vi
      .fn<(a2aPart: A2APart) => GenAIPart | undefined>()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce({text: 'kept'});
    const request = createRequest({
      userMessage: message([textPart('dropped'), textPart('kept')]),
    });

    const result = convertA2aRequestToAgentRunRequest(request, partConverter);

    expect(result.newMessage?.parts).toEqual([{text: 'kept'}]);
  });

  it('drops a part the converter maps to null', () => {
    const partConverter = vi
      .fn<(a2aPart: A2APart) => GenAIPart | null>()
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({text: 'kept'});
    const request = createRequest({
      userMessage: message([textPart('dropped'), textPart('kept')]),
    });

    const result = convertA2aRequestToAgentRunRequest(request, partConverter);

    expect(result.newMessage?.parts).toEqual([{text: 'kept'}]);
  });

  it('converts the parts with toGenAIPart by default', () => {
    const request = createRequest({
      userMessage: message([textPart('hello')]),
    });

    const result = convertA2aRequestToAgentRunRequest(request);

    expect(result.newMessage?.parts).toEqual([{text: 'hello', thought: false}]);
  });

  it('forces the user role on a message an agent sent', () => {
    const request = createRequest({
      userMessage: message([textPart('hello')], 'agent'),
    });

    const result = convertA2aRequestToAgentRunRequest(request);

    expect(result.newMessage?.role).toBe('user');
  });

  it('leaves the incoming request unchanged', () => {
    const parts = [textPart('hello')];
    const request = createRequest({userMessage: message(parts)});

    convertA2aRequestToAgentRunRequest(request);

    expect(request.userMessage.parts).toEqual([{kind: 'text', text: 'hello'}]);
  });
});
