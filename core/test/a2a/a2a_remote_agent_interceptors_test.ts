/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `TestRemoteA2aAgentInterceptors` and `TestRemoteA2aAgentDeepcopy` from
 * `tests/unittests/agents/test_remote_a2a_agent.py` on `google/adk-python`
 * `main`. Each reference test keeps its Python name, so a reviewer can grep
 * for it in either repository.
 */

import {Message} from '@a2a-js/sdk';
import {
  A2ABeforeRequestResult,
  A2ACardRequestInterceptor,
  A2AMessageToEventConverter,
  A2ARequestInterceptor,
  Event as AdkEvent,
  createEvent,
  createSession,
  InvocationContext,
  PluginManager,
  RemoteA2AAgent,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
// The chain drivers are internal, matching adk-python's `a2a/agent/utils.py`,
// so they are imported by path rather than through the package barrel.
import {
  executeAfterRequestInterceptors,
  executeBeforeCardRequestInterceptors,
  executeBeforeRequestInterceptors,
  isA2AMessage,
} from '../../src/a2a/a2a_remote_agent_interceptors.js';
import {createRecordingClient, RecordingTransport} from './a2a_client_fakes.js';

function createContext(state: Record<string, unknown> = {}): InvocationContext {
  const session = createSession({
    id: 'session-123',
    appName: 'test-app',
    userId: 'test-user',
    state,
    events: [
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      }),
    ],
  });
  return new InvocationContext({
    invocationId: 'invocation-123',
    session,
    pluginManager: new PluginManager([]),
  });
}

function createMessage(messageId: string, text: string): Message {
  return {
    kind: 'message',
    messageId,
    role: 'agent',
    parts: [{kind: 'text', text}],
  };
}

describe('A2A remote agent interceptors', () => {
  describe('executeBeforeRequestInterceptors', () => {
    it('test_execute_before_request_interceptors_none', async () => {
      const ctx = createContext({key: 'value'});
      const request = createMessage('req', 'hi');

      const result = await executeBeforeRequestInterceptors(
        undefined,
        ctx,
        request,
      );

      expect(result.request).toBe(request);
      expect(result.params).toEqual({});
    });

    it('test_execute_before_request_interceptors_empty', async () => {
      const ctx = createContext({key: 'value'});
      const request = createMessage('req', 'hi');

      const result = await executeBeforeRequestInterceptors([], ctx, request);

      expect(result.request).toBe(request);
      expect(result.params).toEqual({});
    });

    it('test_execute_before_request_interceptors_success', async () => {
      const ctx = createContext();
      const request = createMessage('req', 'hi');
      const newRequest = createMessage('req-2', 'rewritten');
      const interceptor: A2ARequestInterceptor = {
        beforeRequest: vi.fn(
          async (): Promise<A2ABeforeRequestResult> => ({
            request: newRequest,
            params: {requestMetadata: {updated: 'true'}},
          }),
        ),
      };

      const result = await executeBeforeRequestInterceptors(
        [interceptor],
        ctx,
        request,
      );

      expect(result.request).toBe(newRequest);
      expect(result.params.requestMetadata).toEqual({updated: 'true'});
      expect(interceptor.beforeRequest).toHaveBeenCalledOnce();
    });

    it('test_execute_before_request_interceptors_returns_event', async () => {
      const ctx = createContext();
      const request = createMessage('req', 'hi');
      const event = createEvent({author: 'agent', invocationId: 'inv'});
      const first: A2ARequestInterceptor = {
        beforeRequest: vi.fn(
          async (): Promise<A2ABeforeRequestResult> => ({
            request: event,
            params: {requestMetadata: {updated: 'true'}},
          }),
        ),
      };
      const second: A2ARequestInterceptor = {
        beforeRequest: vi.fn(
          async (
            _ctx,
            passedRequest,
            params,
          ): Promise<A2ABeforeRequestResult> => ({
            request: passedRequest,
            params,
          }),
        ),
      };

      const result = await executeBeforeRequestInterceptors(
        [first, second],
        ctx,
        request,
      );

      expect(result.request).toBe(event);
      expect(result.params.requestMetadata).toEqual({updated: 'true'});
      expect(first.beforeRequest).toHaveBeenCalledOnce();
      expect(second.beforeRequest).not.toHaveBeenCalled();
    });

    it('test_execute_before_request_interceptors_no_before_request', async () => {
      const ctx = createContext();
      const request = createMessage('req', 'hi');

      const result = await executeBeforeRequestInterceptors([{}], ctx, request);

      expect(result.request).toBe(request);
      expect(result.params).toEqual({});
    });
  });

  describe('executeAfterRequestInterceptors', () => {
    it('test_execute_after_request_interceptors_none', async () => {
      const ctx = createContext();
      const response = createMessage('resp', 'hi');
      const event = createEvent({author: 'agent'});

      const result = await executeAfterRequestInterceptors(
        undefined,
        ctx,
        response,
        event,
      );

      expect(result).toBe(event);
    });

    it('test_execute_after_request_interceptors_empty', async () => {
      const ctx = createContext();
      const response = createMessage('resp', 'hi');
      const event = createEvent({author: 'agent'});

      const result = await executeAfterRequestInterceptors(
        [],
        ctx,
        response,
        event,
      );

      expect(result).toBe(event);
    });

    it('test_execute_after_request_interceptors_success', async () => {
      const ctx = createContext();
      const response = createMessage('resp', 'hi');
      const event = createEvent({author: 'agent'});
      const newEvent = createEvent({author: 'agent', invocationId: 'new'});
      const interceptor: A2ARequestInterceptor = {
        afterRequest: vi.fn(async () => newEvent),
      };

      const result = await executeAfterRequestInterceptors(
        [interceptor],
        ctx,
        response,
        event,
      );

      expect(result).toBe(newEvent);
      expect(interceptor.afterRequest).toHaveBeenCalledExactlyOnceWith(
        ctx,
        response,
        event,
      );
    });

    it('test_execute_after_request_interceptors_reverse_order', async () => {
      const ctx = createContext();
      const response = createMessage('resp', 'hi');
      const event = createEvent({author: 'agent'});
      const event1 = createEvent({author: 'agent', invocationId: 'one'});
      const event2 = createEvent({author: 'agent', invocationId: 'two'});
      const first: A2ARequestInterceptor = {
        afterRequest: vi.fn(async () => event1),
      };
      const second: A2ARequestInterceptor = {
        afterRequest: vi.fn(async () => event2),
      };

      const result = await executeAfterRequestInterceptors(
        [first, second],
        ctx,
        response,
        event,
      );

      expect(result).toBe(event1);
      expect(second.afterRequest).toHaveBeenCalledExactlyOnceWith(
        ctx,
        response,
        event,
      );
      expect(first.afterRequest).toHaveBeenCalledExactlyOnceWith(
        ctx,
        response,
        event2,
      );
    });

    it('test_execute_after_request_interceptors_returns_none', async () => {
      const ctx = createContext();
      const response = createMessage('resp', 'hi');
      const event = createEvent({author: 'agent'});
      const first: A2ARequestInterceptor = {
        afterRequest: vi.fn(async () => undefined),
      };
      const second: A2ARequestInterceptor = {
        afterRequest: vi.fn(async () => undefined),
      };

      const result = await executeAfterRequestInterceptors(
        [first, second],
        ctx,
        response,
        event,
      );

      expect(result).toBeUndefined();
      expect(second.afterRequest).toHaveBeenCalledExactlyOnceWith(
        ctx,
        response,
        event,
      );
      expect(first.afterRequest).not.toHaveBeenCalled();
    });

    it('test_execute_after_request_interceptors_no_after_request', async () => {
      const ctx = createContext();
      const response = createMessage('resp', 'hi');
      const event = createEvent({author: 'agent'});

      const result = await executeAfterRequestInterceptors(
        [{}],
        ctx,
        response,
        event,
      );

      expect(result).toBe(event);
    });
  });

  describe('executeBeforeCardRequestInterceptors', () => {
    it('test_execute_before_card_request_interceptors_none', async () => {
      const headers = await executeBeforeCardRequestInterceptors(
        undefined,
        createContext(),
      );

      expect(headers).toBeUndefined();
    });

    it('test_execute_before_card_request_interceptors_merges', async () => {
      const first: A2ACardRequestInterceptor = {
        beforeRequest: async () => ({headers: {'X-Common': 'a', 'X-A': '1'}}),
      };
      const second: A2ACardRequestInterceptor = {
        beforeRequest: async () => ({headers: {'X-Common': 'b', 'X-B': '2'}}),
      };

      const headers = await executeBeforeCardRequestInterceptors(
        [first, second],
        createContext(),
      );

      expect(headers).toEqual({'X-Common': 'b', 'X-A': '1', 'X-B': '2'});
    });

    it('test_execute_before_card_request_interceptors_skips_none_provider', async () => {
      const headers = await executeBeforeCardRequestInterceptors(
        [{}],
        createContext(),
      );

      expect(headers).toBeUndefined();
    });

    it('runs no interceptor when there is no invocation context', async () => {
      const interceptor: A2ACardRequestInterceptor = {
        beforeRequest: vi.fn(async () => ({headers: {'X-A': '1'}})),
      };

      const headers = await executeBeforeCardRequestInterceptors(
        [interceptor],
        undefined,
      );

      expect(headers).toBeUndefined();
      expect(interceptor.beforeRequest).not.toHaveBeenCalled();
    });

    it('returns undefined when an interceptor supplies no headers', async () => {
      const headers = await executeBeforeCardRequestInterceptors(
        [{beforeRequest: async () => ({})}],
        createContext(),
      );

      expect(headers).toBeUndefined();
    });
  });

  describe('isA2AMessage', () => {
    it('accepts an A2A message and rejects an ADK event', () => {
      expect(isA2AMessage(createMessage('req', 'hi'))).toBe(true);
      expect(isA2AMessage(createEvent({author: 'agent'}))).toBe(false);
    });
  });

  describe('clone', () => {
    it('test_deepcopy_config', async () => {
      // adk-python deep-copies the objects inside `request_interceptors` and
      // asserts `copied[0] is not original[0]`. adk-js interceptors are plain
      // objects holding functions, and `BaseAgent.clone` copies the array
      // without copying its members, so the caller's own callables survive.
      // Assert that observable contract instead of the Python identity check.
      const converted = createEvent({author: 'remote', invocationId: 'inv'});
      const converter = vi.fn<A2AMessageToEventConverter>(() => converted);
      const interceptor: A2ARequestInterceptor = {
        beforeRequest: vi.fn(
          async (_ctx, request, params): Promise<A2ABeforeRequestResult> => ({
            request,
            params,
          }),
        ),
      };
      const transport = new RecordingTransport([
        createMessage('resp', 'from remote'),
      ]);
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        client: createRecordingClient(transport),
        a2aMessageConverter: converter,
        requestInterceptors: [interceptor],
      });

      const copied = agent.clone();
      const events: AdkEvent[] = [];
      for await (const event of copied.runAsync(createContext())) {
        events.push(event);
      }

      expect(converter).toHaveBeenCalled();
      expect(interceptor.beforeRequest).toHaveBeenCalled();
      expect(events).toContain(converted);
    });
  });
});
