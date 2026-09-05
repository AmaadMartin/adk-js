/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HTTP_EXTENSION_HEADER, Message} from '@a2a-js/sdk';
import {
  A2ABeforeRequestResult,
  A2AMessageToEventConverter,
  Event as AdkEvent,
  createEvent,
  createSession,
  NEW_A2A_ADK_INTEGRATION_EXTENSION,
  newIntegrationExtensionInterceptor,
  RemoteA2AAgent,
  Session,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {
  A2ACardRequestInterceptor,
  A2ARequestInterceptor,
  executeAfterRequestInterceptors,
  executeBeforeCardRequestInterceptors,
  executeBeforeRequestInterceptors,
  isA2AMessage,
} from '../../src/a2a/a2a_remote_agent_interceptors.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createRecordingClient, RecordingTransport} from './a2a_client_fakes.js';

const CTX = new InvocationContext({
  invocationId: 'inv-1',
  session: {
    id: 'session-1',
    appName: 'app',
    userId: 'user',
    state: {},
    events: [],
    lastUpdateTime: Date.now(),
  } as Session,
  pluginManager: new PluginManager(),
});

const REQUEST: Message = {
  kind: 'message',
  messageId: 'm-1',
  role: 'user',
  parts: [{kind: 'text', text: 'hello'}],
};

/** An interceptor that records its name in the request metadata. */
function recording(name: string, log: string[]): A2ARequestInterceptor {
  return {
    async beforeRequest(_ctx, request, params) {
      log.push(`before:${name}`);
      return {request, params};
    },
    async afterRequest(_ctx, _response, event) {
      log.push(`after:${name}`);
      return event;
    },
  };
}

describe('executeBeforeCardRequestInterceptors', () => {
  it('returns undefined with no interceptors', async () => {
    expect(
      await executeBeforeCardRequestInterceptors(undefined, CTX),
    ).toBeUndefined();
  });

  it('returns undefined without a context', async () => {
    const interceptor: A2ACardRequestInterceptor = {
      async beforeRequest() {
        return {headers: {A: '1'}};
      },
    };

    expect(
      await executeBeforeCardRequestInterceptors([interceptor], undefined),
    ).toBeUndefined();
  });

  it('returns undefined when no interceptor asks for a header', async () => {
    const interceptor: A2ACardRequestInterceptor = {
      async beforeRequest() {
        return {};
      },
    };

    expect(
      await executeBeforeCardRequestInterceptors([interceptor], CTX),
    ).toBeUndefined();
  });

  it('merges headers in list order, with the later one winning', async () => {
    const first: A2ACardRequestInterceptor = {
      async beforeRequest() {
        return {headers: {Shared: 'first', OnlyFirst: 'a'}};
      },
    };
    const second: A2ACardRequestInterceptor = {
      async beforeRequest() {
        return {headers: {Shared: 'second'}};
      },
    };

    expect(
      await executeBeforeCardRequestInterceptors([first, second], CTX),
    ).toEqual({Shared: 'second', OnlyFirst: 'a'});
  });

  it('skips an interceptor with no beforeRequest hook', async () => {
    const withHook: A2ACardRequestInterceptor = {
      async beforeRequest() {
        return {headers: {A: '1'}};
      },
    };

    expect(
      await executeBeforeCardRequestInterceptors([{}, withHook], CTX),
    ).toEqual({A: '1'});
  });
});

describe('executeBeforeRequestInterceptors', () => {
  it('returns the request unchanged with no interceptors', async () => {
    const result = await executeBeforeRequestInterceptors(
      undefined,
      CTX,
      REQUEST,
    );

    expect(result.request).toBe(REQUEST);
    expect(result.params).toEqual({});
  });

  it('runs the hooks in list order', async () => {
    const log: string[] = [];

    await executeBeforeRequestInterceptors(
      [recording('one', log), recording('two', log)],
      CTX,
      REQUEST,
    );

    expect(log).toEqual(['before:one', 'before:two']);
  });

  it('passes each hook the request the previous one returned', async () => {
    const replaced: Message = {...REQUEST, messageId: 'replaced'};
    const seen: string[] = [];
    const first: A2ARequestInterceptor = {
      async beforeRequest(_ctx, request, params) {
        seen.push(request.messageId);
        return {request: replaced, params};
      },
    };
    const second: A2ARequestInterceptor = {
      async beforeRequest(_ctx, request, params) {
        seen.push(request.messageId);
        return {request, params};
      },
    };

    const result = await executeBeforeRequestInterceptors(
      [first, second],
      CTX,
      REQUEST,
    );

    expect(seen).toEqual(['m-1', 'replaced']);
    expect(result.request).toBe(replaced);
  });

  it('stops at a hook that returns an event, and carries its params', async () => {
    const abort = createEvent({author: 'agent', errorMessage: 'refused'});
    const log: string[] = [];
    const aborting: A2ARequestInterceptor = {
      async beforeRequest() {
        return {request: abort, params: {headers: {A: '1'}}};
      },
    };

    const result = await executeBeforeRequestInterceptors(
      [aborting, recording('after-abort', log)],
      CTX,
      REQUEST,
    );

    expect(result.request).toBe(abort);
    expect(result.params).toEqual({headers: {A: '1'}});
    expect(log).toEqual([]);
  });

  it('skips an interceptor with no beforeRequest hook', async () => {
    const log: string[] = [];

    await executeBeforeRequestInterceptors(
      [{}, recording('one', log)],
      CTX,
      REQUEST,
    );

    expect(log).toEqual(['before:one']);
  });
});

describe('executeAfterRequestInterceptors', () => {
  const event = createEvent({author: 'agent'});

  it('returns the event unchanged with no interceptors', async () => {
    expect(
      await executeAfterRequestInterceptors(undefined, CTX, REQUEST, event),
    ).toBe(event);
  });

  it('runs the hooks in reverse list order', async () => {
    const log: string[] = [];

    await executeAfterRequestInterceptors(
      [recording('one', log), recording('two', log)],
      CTX,
      REQUEST,
      event,
    );

    expect(log).toEqual(['after:two', 'after:one']);
  });

  it('drops the event when a hook returns undefined', async () => {
    const log: string[] = [];
    const dropping: A2ARequestInterceptor = {
      async afterRequest() {
        return undefined;
      },
    };

    const result = await executeAfterRequestInterceptors(
      [recording('outer', log), dropping],
      CTX,
      REQUEST,
      event,
    );

    expect(result).toBeUndefined();
    expect(log).toEqual([]);
  });

  it('passes each hook the event the previous one returned', async () => {
    const replaced: AdkEvent = createEvent({author: 'agent', partial: true});
    const seen: boolean[] = [];
    const replacing: A2ARequestInterceptor = {
      async afterRequest() {
        return replaced;
      },
    };
    const observing: A2ARequestInterceptor = {
      async afterRequest(_ctx, _response, incoming) {
        seen.push(incoming === replaced);
        return incoming;
      },
    };

    const result = await executeAfterRequestInterceptors(
      [observing, replacing],
      CTX,
      REQUEST,
      event,
    );

    expect(seen).toEqual([true]);
    expect(result).toBe(replaced);
  });

  it('skips an interceptor with no afterRequest hook', async () => {
    const log: string[] = [];

    await executeAfterRequestInterceptors(
      [{}, recording('one', log)],
      CTX,
      REQUEST,
      event,
    );

    expect(log).toEqual(['after:one']);
  });
});

describe('isA2AMessage', () => {
  it('recognises an A2A message', () => {
    expect(isA2AMessage(REQUEST)).toBe(true);
  });

  it('rejects an ADK event', () => {
    expect(isA2AMessage(createEvent({author: 'agent'}))).toBe(false);
  });
});

describe('newIntegrationExtensionInterceptor', () => {
  const declaredExtensions = async (
    headers?: Record<string, string>,
  ): Promise<string | undefined> => {
    const result = await executeBeforeRequestInterceptors(
      [newIntegrationExtensionInterceptor],
      CTX,
      REQUEST,
    );
    // Re-run with pre-existing headers when the caller supplied some.
    if (!headers) {
      return result.params.headers?.[HTTP_EXTENSION_HEADER];
    }
    const seeded = await newIntegrationExtensionInterceptor.beforeRequest?.(
      CTX,
      REQUEST,
      {headers},
    );
    return seeded?.params.headers?.[HTTP_EXTENSION_HEADER];
  };

  it('declares the extension when none is declared yet', async () => {
    expect(await declaredExtensions()).toBe(NEW_A2A_ADK_INTEGRATION_EXTENSION);
  });

  it('keeps the extensions the caller already declared', async () => {
    expect(await declaredExtensions({[HTTP_EXTENSION_HEADER]: 'other'})).toBe(
      `other,${NEW_A2A_ADK_INTEGRATION_EXTENSION}`,
    );
  });

  it('does not declare the extension twice', async () => {
    expect(
      await declaredExtensions({
        [HTTP_EXTENSION_HEADER]: NEW_A2A_ADK_INTEGRATION_EXTENSION,
      }),
    ).toBe(NEW_A2A_ADK_INTEGRATION_EXTENSION);
  });

  it('ignores an empty extension header', async () => {
    expect(await declaredExtensions({[HTTP_EXTENSION_HEADER]: ''})).toBe(
      NEW_A2A_ADK_INTEGRATION_EXTENSION,
    );
  });
});

/**
 * Ports `TestRemoteA2aAgentDeepcopy` from
 * `tests/unittests/agents/test_remote_a2a_agent.py` on `google/adk-python`
 * `main`, keeping the reference test's name so a reviewer can grep for it in
 * either repository.
 */
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
      {
        kind: 'message',
        messageId: 'resp',
        role: 'agent',
        parts: [{kind: 'text', text: 'from remote'}],
      },
    ]);
    const agent = new RemoteA2AAgent({
      name: 'remote_agent',
      client: createRecordingClient(transport),
      a2aMessageConverter: converter,
      requestInterceptors: [interceptor],
    });

    const context = new InvocationContext({
      invocationId: 'invocation-123',
      session: createSession({
        id: 'session-123',
        appName: 'test-app',
        userId: 'test-user',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'hello'}]},
          }),
        ],
      }),
      pluginManager: new PluginManager(),
    });
    const copied = agent.clone();
    const events: AdkEvent[] = [];
    for await (const event of copied.runAsync(context)) {
      events.push(event);
    }

    expect(converter).toHaveBeenCalled();
    expect(interceptor.beforeRequest).toHaveBeenCalled();
    expect(events).toContain(converted);
  });
});
