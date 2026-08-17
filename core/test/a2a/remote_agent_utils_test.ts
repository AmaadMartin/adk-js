/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message, TextPart} from '@a2a-js/sdk';
import {ClientCallContext} from '@a2a-js/sdk/client';
import {describe, expect, it, vi} from 'vitest';
import {A2A_SESSION_STATE_CONTEXT_KEY} from '../../src/a2a/a2a_remote_agent_config.js';
import {
  getFunctionResponseCallId,
  getUserFunctionCallAt,
  isFunctionCallEvent,
  presentAsUserMessage,
  runAfterRequestInterceptors,
  runBeforeCardRequestInterceptors,
  runBeforeRequestInterceptors,
  toMissingRemoteSessionParts,
} from '../../src/a2a/a2a_remote_agent_utils.js';
import {AdkMetadataKeys} from '../../src/a2a/metadata_converter_utils.js';
import {BaseAgent} from '../../src/agents/base_agent.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession, Session} from '../../src/sessions/session.js';

describe('remote_agent_utils', () => {
  const mockAgent = {
    name: 'test-agent',
  } as unknown as BaseAgent;

  const mockCtx = {
    agent: mockAgent,
    invocationId: 'test-invocation-id',
  } as unknown as InvocationContext;

  const sessionCtx = new InvocationContext({
    invocationId: 'test-invocation-id',
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      state: {token: 'secret'},
    }),
    pluginManager: new PluginManager(),
  });

  describe('getFunctionResponseCallId', () => {
    it('should return undefined if no content', () => {
      const event = createEvent({author: 'user'});
      expect(getFunctionResponseCallId(event)).toBeUndefined();
    });

    it('should return call ID if functionResponse present', () => {
      const event = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-123',
                name: 'test_tool',
                response: {result: 'ok'},
              },
            },
          ],
        },
      });
      expect(getFunctionResponseCallId(event)).toBe('call-123');
    });
  });

  describe('isFunctionCallEvent', () => {
    it('should return false if no content', () => {
      const event = createEvent({author: 'user'});
      expect(isFunctionCallEvent(event, 'call-123')).toBe(false);
    });

    it('should return true if functionCall ID matches', () => {
      const event = createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-123',
                name: 'test_tool',
                args: {},
              },
            },
          ],
        },
      });
      expect(isFunctionCallEvent(event, 'call-123')).toBe(true);
    });

    it('should return false if functionCall ID does not match', () => {
      const event = createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-456',
                name: 'test_tool',
                args: {},
              },
            },
          ],
        },
      });
      expect(isFunctionCallEvent(event, 'call-123')).toBe(false);
    });
  });

  describe('getUserFunctionCallAt', () => {
    it('should return undefined for invalid index', () => {
      const session = {events: []} as unknown as Session;
      expect(getUserFunctionCallAt(session, 0)).toBeUndefined();
    });

    it('should return undefined if event author is not user', () => {
      const event = createEvent({author: 'agent'});
      const session = {events: [event]} as unknown as Session;
      expect(getUserFunctionCallAt(session, 0)).toBeUndefined();
    });

    it('should return undefined if no functionResponse', () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      });
      const session = {events: [event]} as unknown as Session;
      expect(getUserFunctionCallAt(session, 0)).toBeUndefined();
    });

    it('should return UserFunctionCall if request event found', () => {
      const requestEvent = createEvent({
        author: 'agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'call-123', name: 'tool'}}],
        },
        customMetadata: {
          [AdkMetadataKeys.TASK_ID]: 'task-123',
          [AdkMetadataKeys.CONTEXT_ID]: 'ctx-123',
        },
      });

      const responseEvent = createEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [{functionResponse: {id: 'call-123', name: 'tool'}}],
        },
      });

      const session = {
        events: [requestEvent, responseEvent],
      } as unknown as Session;

      const result = getUserFunctionCallAt(session, 1);
      expect(result).toBeDefined();
      expect(result?.taskId).toBe('task-123');
      expect(result?.contextId).toBe('ctx-123');
      expect(result?.response).toBe(responseEvent);
    });
  });

  describe('presentAsUserMessage', () => {
    it('should handle text parts', () => {
      const agentEvent = createEvent({
        author: 'other-agent',
        content: {role: 'model', parts: [{text: 'hello'}]},
      });

      const result = presentAsUserMessage(mockCtx, agentEvent);
      expect(result.author).toBe('user');
      expect(result.content?.parts![0].text).toBe('For context:');
      expect(result.content?.parts![1].text).toBe('[other-agent] said: hello');
    });

    it('should handle functionCall parts', () => {
      const agentEvent = createEvent({
        author: 'other-agent',
        content: {
          role: 'model',
          parts: [{functionCall: {name: 'tool', args: {x: 1}}}],
        },
      });

      const result = presentAsUserMessage(mockCtx, agentEvent);
      expect(result.content?.parts![1].text).toContain('called tool tool');
      expect(result.content?.parts![1].text).toContain('{"x":1}');
    });

    it('should handle functionResponse parts', () => {
      const agentEvent = createEvent({
        author: 'other-agent',
        content: {
          role: 'model',
          parts: [{functionResponse: {name: 'tool', response: {y: 2}}}],
        },
      });

      const result = presentAsUserMessage(mockCtx, agentEvent);
      expect(result.content?.parts![1].text).toContain('tool returned result');
      expect(result.content?.parts![1].text).toContain('{"y":2}');
    });
  });

  describe('toMissingRemoteSessionParts', () => {
    it('should return all parts if no previous remote response', () => {
      const event1 = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      });
      const session = {events: [event1]} as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      expect(result.parts.length).toBe(1);
      expect((result.parts[0] as TextPart).text).toBe('hello');
      expect(result.contextId).toBeUndefined();
    });

    it('should only return parts after last remote response', () => {
      const remoteResponse = createEvent({
        author: 'test-agent',
        content: {role: 'model', parts: [{text: 'response'}]},
        customMetadata: {
          [AdkMetadataKeys.CONTEXT_ID]: 'ctx-remote',
        },
      });
      const newUserMessage = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'new message'}]},
      });

      const session = {
        events: [remoteResponse, newUserMessage],
      } as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      expect(result.parts.length).toBe(1);
      expect((result.parts[0] as TextPart).text).toBe('new message');
      expect(result.contextId).toBe('ctx-remote');
    });

    it('should wrap other agent messages as user message', () => {
      const otherAgent = createEvent({
        author: 'other-agent',
        content: {role: 'model', parts: [{text: 'other response'}]},
      });

      const session = {events: [otherAgent]} as unknown as Session;

      const result = toMissingRemoteSessionParts(mockCtx, session);
      expect(result.parts.length).toBe(2); // "For context:" and "[other-agent] said: ..."
      expect((result.parts[0] as TextPart).text).toBe('For context:');
      expect((result.parts[1] as TextPart).text).toBe(
        '[other-agent] said: other response',
      );
    });
  });

  describe('runBeforeCardRequestInterceptors', () => {
    it('should return undefined without interceptors', async () => {
      expect(
        await runBeforeCardRequestInterceptors([], mockCtx),
      ).toBeUndefined();
    });

    it('should return undefined when no interceptor contributes a header', async () => {
      const result = await runBeforeCardRequestInterceptors(
        [{}, {beforeRequest: async () => ({})}],
        mockCtx,
      );
      expect(result).toBeUndefined();
    });

    it('should merge headers in list order with the later one winning', async () => {
      const result = await runBeforeCardRequestInterceptors(
        [
          {beforeRequest: async () => ({headers: {a: '1', shared: 'first'}})},
          {beforeRequest: async () => ({headers: {b: '2', shared: 'second'}})},
        ],
        mockCtx,
      );
      expect(result).toEqual({a: '1', b: '2', shared: 'second'});
    });
  });

  describe('runBeforeRequestInterceptors', () => {
    const request: Message = {
      kind: 'message',
      messageId: 'msg-1',
      role: 'user',
      parts: [{kind: 'text', text: 'hello'}],
    };

    it('should return the request and publish session state without interceptors', async () => {
      const [result, params] = await runBeforeRequestInterceptors(
        [],
        sessionCtx,
        request,
      );

      expect(result).toBe(request);
      if (!params.clientCallContext) {
        expect.fail('the params carry no client call context');
      }
      expect(
        A2A_SESSION_STATE_CONTEXT_KEY.get(params.clientCallContext),
      ).toEqual({token: 'secret'});
    });

    it('should apply the message and params an interceptor returns', async () => {
      const replacement: Message = {...request, messageId: 'msg-2'};
      const returnedParams = {clientCallContext: ClientCallContext.create()};

      const [result, params] = await runBeforeRequestInterceptors(
        [{beforeRequest: async () => [replacement, returnedParams]}],
        sessionCtx,
        request,
      );

      expect(result).toBe(replacement);
      expect(params).toBe(returnedParams);
    });

    it('should short-circuit the chain when an interceptor returns an event', async () => {
      const abortEvent = createEvent({author: 'test-agent'});
      const second = vi.fn();

      const [result] = await runBeforeRequestInterceptors(
        [
          {beforeRequest: async (_ctx, _req, params) => [abortEvent, params]},
          {beforeRequest: second},
        ],
        sessionCtx,
        request,
      );

      expect(result).toBe(abortEvent);
      expect(second).not.toHaveBeenCalled();
    });

    it('should skip an interceptor without a beforeRequest hook', async () => {
      const [result] = await runBeforeRequestInterceptors(
        [{}],
        sessionCtx,
        request,
      );
      expect(result).toBe(request);
    });
  });

  describe('runAfterRequestInterceptors', () => {
    const response: Message = {
      kind: 'message',
      messageId: 'resp-1',
      role: 'agent',
      parts: [{kind: 'text', text: 'hi'}],
    };

    it('should return the event unchanged without interceptors', async () => {
      const event = createEvent({author: 'test-agent'});
      expect(
        await runAfterRequestInterceptors([], sessionCtx, response, event),
      ).toBe(event);
    });

    it('should run interceptors in reverse list order', async () => {
      const event = createEvent({author: 'test-agent'});
      const fromSecond = createEvent({author: 'second'});
      const fromFirst = createEvent({author: 'first'});
      const seen: string[] = [];

      const result = await runAfterRequestInterceptors(
        [
          {
            afterRequest: async (_ctx, _resp, incoming) => {
              seen.push(`first:${incoming.author}`);
              return fromFirst;
            },
          },
          {
            afterRequest: async (_ctx, _resp, incoming) => {
              seen.push(`second:${incoming.author}`);
              return fromSecond;
            },
          },
        ],
        sessionCtx,
        response,
        event,
      );

      expect(seen).toEqual(['second:test-agent', 'first:second']);
      expect(result).toBe(fromFirst);
    });

    it('should stop the chain when an interceptor drops the event', async () => {
      const outer = vi.fn();

      const result = await runAfterRequestInterceptors(
        [{afterRequest: outer}, {afterRequest: async () => undefined}],
        sessionCtx,
        response,
        createEvent({author: 'test-agent'}),
      );

      expect(result).toBeUndefined();
      expect(outer).not.toHaveBeenCalled();
    });

    it('should skip an interceptor without an afterRequest hook', async () => {
      const event = createEvent({author: 'test-agent'});
      expect(
        await runAfterRequestInterceptors([{}], sessionCtx, response, event),
      ).toBe(event);
    });
  });
});
