/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Agent-level behaviour of the converter slots and the interceptors, ported
 * from `tests/unittests/agents/test_remote_a2a_agent.py` on `google/adk-python`
 * `main`. Each reference test keeps its Python name.
 *
 * adk-python has two response handlers, a legacy one and a v2 one, so it
 * repeats the "converter returns None" cases for each. adk-js has a single
 * dispatch (`toAdkEvent`), so the `legacy_*` and `v2_*` names both exercise
 * that one path with a different A2A frame kind.
 *
 * `test_ensure_resolved_no_ctx_ignores_card_interceptors` lives in
 * `a2a_remote_agent_interceptors_test.ts`: adk-js always has an
 * `InvocationContext` at the agent level, so the no-context rule is only
 * observable on `executeBeforeCardRequestInterceptors` itself.
 */

import {
  AgentCard,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {
  A2AArtifactUpdateToEventConverter,
  A2ACardRequestInterceptor,
  A2AMessageToEventConverter,
  A2APartToGenAIPartConverter,
  A2ARequestInterceptor,
  A2AStatusUpdateToEventConverter,
  A2ATaskToEventConverter,
  Event as AdkEvent,
  createEvent,
  createSession,
  InvocationContext,
  PluginManager,
  RemoteA2AAgent,
  RemoteA2AAgentConfig,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  createRecordingClient,
  createTestAgentCard,
  RecordingTransport,
  StubClientFactory,
} from './a2a_client_fakes.js';

const CARD_URL = 'https://example.com';

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

function agentMessage(text: string, contextId?: string): Message {
  return {
    kind: 'message',
    messageId: 'resp-1',
    role: 'agent',
    parts: [{kind: 'text', text}],
    ...(contextId ? {contextId} : {}),
  };
}

function completedTask(text: string): Task {
  return {
    kind: 'task',
    id: 'task-123',
    contextId: 'ctx-123',
    status: {
      state: 'completed',
      message: agentMessage(text),
    },
  };
}

function statusUpdate(text: string): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId: 'task-123',
    contextId: 'ctx-123',
    final: false,
    status: {state: 'working', message: agentMessage(text)},
  };
}

function artifactUpdate(text: string): TaskArtifactUpdateEvent {
  return {
    kind: 'artifact-update',
    taskId: 'task-123',
    contextId: 'ctx-123',
    lastChunk: true,
    artifact: {artifactId: 'artifact-1', parts: [{kind: 'text', text}]},
  };
}

/** Runs the agent to completion and collects everything it yields. */
async function drain(
  agent: RemoteA2AAgent,
  ctx: InvocationContext,
): Promise<AdkEvent[]> {
  const events: AdkEvent[] = [];
  for await (const event of agent.runAsync(ctx)) {
    events.push(event);
  }
  return events;
}

/** Builds an agent whose remote returns `frames`, and its transport. */
function createAgent(
  frames: Array<
    Message | Task | TaskStatusUpdateEvent | TaskArtifactUpdateEvent
  >,
  config: Partial<RemoteA2AAgentConfig> = {},
  card: AgentCard = createTestAgentCard(),
): {agent: RemoteA2AAgent; transport: RecordingTransport} {
  const transport = new RecordingTransport(frames, frames[0] as Message | Task);
  return {
    agent: new RemoteA2AAgent({
      name: 'remote_agent',
      agentCard: card,
      client: createRecordingClient(transport, card),
      ...config,
    }),
    transport,
  };
}

/** Records every card fetch and answers each with `card`. */
function stubCardFetch(card: AgentCard): Array<Record<string, string>> {
  const seen: Array<Record<string, string>> = [];
  const fetchStub: typeof fetch = async (_input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => {
      headers[name] = value;
    });
    seen.push(headers);
    return new Response(JSON.stringify(card), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  };
  vi.stubGlobal('fetch', fetchStub);
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RemoteA2AAgent card request interceptors', () => {
  it('test_card_request_interceptors_injects_headers', async () => {
    const card = createTestAgentCard();
    const seen = stubCardFetch(card);
    const interceptor: A2ACardRequestInterceptor = {
      beforeRequest: async (ctx) => ({
        headers: {authorization: `Bearer ${ctx.session.state['token']}`},
      }),
    };
    const transport = new RecordingTransport([agentMessage('hi')]);
    const agent = new RemoteA2AAgent({
      name: 'remote_agent',
      agentCard: CARD_URL,
      client: createRecordingClient(transport, card),
      cardRequestInterceptors: [interceptor],
    });

    await drain(agent, createContext({token: 'abc'}));

    expect(seen).toHaveLength(1);
    expect(seen[0]['authorization']).toBe('Bearer abc');
  });

  it('test_card_request_interceptors_merge_later_overrides', async () => {
    const card = createTestAgentCard();
    const seen = stubCardFetch(card);
    const transport = new RecordingTransport([agentMessage('hi')]);
    const agent = new RemoteA2AAgent({
      name: 'remote_agent',
      agentCard: CARD_URL,
      client: createRecordingClient(transport, card),
      cardRequestInterceptors: [
        {beforeRequest: async () => ({headers: {'x-common': 'a', 'x-a': '1'}})},
        {beforeRequest: async () => ({headers: {'x-common': 'b', 'x-b': '2'}})},
      ],
    });

    await drain(agent, createContext());

    expect(seen[0]['x-common']).toBe('b');
    expect(seen[0]['x-a']).toBe('1');
    expect(seen[0]['x-b']).toBe('2');
  });

  it('test_ensure_resolved_refetches_card_when_interceptor_set', async () => {
    const card = createTestAgentCard();
    const seen = stubCardFetch(card);
    const transport = new RecordingTransport([agentMessage('hi')]);
    const agent = new RemoteA2AAgent({
      name: 'remote_agent',
      agentCard: CARD_URL,
      client: createRecordingClient(transport, card),
      cardRequestInterceptors: [
        {beforeRequest: async () => ({headers: {authorization: 'Bearer x'}})},
      ],
    });

    await drain(agent, createContext());
    await drain(agent, createContext());

    expect(seen).toHaveLength(2);
  });

  it('test_card_interceptor_does_not_leak_across_sessions', async () => {
    const card = createTestAgentCard();
    const seen = stubCardFetch(card);
    const transport = new RecordingTransport([agentMessage('hi')]);
    const agent = new RemoteA2AAgent({
      name: 'remote_agent',
      agentCard: CARD_URL,
      client: createRecordingClient(transport, card),
      cardRequestInterceptors: [
        {
          beforeRequest: async (ctx) => ({
            headers: {authorization: `Bearer ${ctx.session.state['token']}`},
          }),
        },
      ],
    });

    await drain(agent, createContext({token: 'AAA'}));
    await drain(agent, createContext({token: 'BBB'}));

    expect(seen.map((headers) => headers['authorization'])).toEqual([
      'Bearer AAA',
      'Bearer BBB',
    ]);
  });

  it('builds a client per invocation when no client is supplied', async () => {
    const card = createTestAgentCard();
    const seen = stubCardFetch(card);
    const transport = new RecordingTransport([agentMessage('hi')]);
    const factory = new StubClientFactory(
      createRecordingClient(transport, card),
    );
    const agent = new RemoteA2AAgent({
      name: 'remote_agent',
      agentCard: CARD_URL,
      clientFactory: factory,
      cardRequestInterceptors: [
        {beforeRequest: async () => ({headers: {authorization: 'Bearer x'}})},
      ],
    });

    await drain(agent, createContext());
    await drain(agent, createContext());

    expect(seen).toHaveLength(2);
    expect(factory.createdFor).toHaveLength(2);
  });

  it('test_ensure_resolved_caches_card_without_interceptor', async () => {
    const card = createTestAgentCard();
    const seen = stubCardFetch(card);
    const transport = new RecordingTransport([agentMessage('hi')]);
    const agent = new RemoteA2AAgent({
      name: 'remote_agent',
      agentCard: CARD_URL,
      client: createRecordingClient(transport, card),
    });

    await drain(agent, createContext());
    await drain(agent, createContext());

    expect(seen).toHaveLength(1);
  });

  it('test_card_request_interceptors_ignored_for_direct_card', async () => {
    const card = createTestAgentCard();
    const seen = stubCardFetch(card);
    const beforeRequest = vi.fn(async () => ({
      headers: {authorization: 'Bearer x'},
    }));
    const {agent} = createAgent([agentMessage('hi')], {
      cardRequestInterceptors: [{beforeRequest}],
    });

    await drain(agent, createContext());
    await drain(agent, createContext());

    expect(seen).toHaveLength(0);
    expect(beforeRequest).not.toHaveBeenCalled();
  });

  it('sends no extra header when no card interceptor is configured', async () => {
    const card = createTestAgentCard();
    const seen = stubCardFetch(card);
    const transport = new RecordingTransport([agentMessage('hi')]);
    const agent = new RemoteA2AAgent({
      name: 'remote_agent',
      agentCard: CARD_URL,
      client: createRecordingClient(transport, card),
    });

    await drain(agent, createContext());

    expect(seen[0]['authorization']).toBeUndefined();
  });
});

describe('RemoteA2AAgent converters returning undefined', () => {
  it('test_v2_message_converter_returns_none', async () => {
    const message = vi.fn<A2AMessageToEventConverter>(() => undefined);
    const {agent} = createAgent([agentMessage('hi')], {
      a2aMessageConverter: message,
    });

    expect(await drain(agent, createContext())).toEqual([]);
    expect(message).toHaveBeenCalledOnce();
  });

  it('test_v2_message_converter_returns_none_with_context_id', async () => {
    const message = vi.fn<A2AMessageToEventConverter>(() => undefined);
    const {agent} = createAgent([agentMessage('hi', 'ctx-123')], {
      a2aMessageConverter: message,
    });

    expect(await drain(agent, createContext())).toEqual([]);
  });

  it('test_v2_task_converter_returns_none', async () => {
    const task = vi.fn<A2ATaskToEventConverter>(() => undefined);
    const {agent} = createAgent([completedTask('done')], {
      a2aTaskConverter: task,
    });

    expect(await drain(agent, createContext())).toEqual([]);
    expect(task).toHaveBeenCalledOnce();
  });

  it('test_v2_status_update_converter_returns_none', async () => {
    const update = vi.fn<A2AStatusUpdateToEventConverter>(() => undefined);
    const {agent} = createAgent([statusUpdate('working')], {
      a2aStatusUpdateConverter: update,
    });

    expect(await drain(agent, createContext())).toEqual([]);
    expect(update).toHaveBeenCalledOnce();
  });

  it('test_legacy_message_converter_returns_none', async () => {
    const {agent} = createAgent([agentMessage('hi')], {
      a2aMessageConverter: () => undefined,
    });

    expect(await drain(agent, createContext())).toEqual([]);
  });

  it('test_legacy_task_converter_returns_none_no_update', async () => {
    const {agent} = createAgent([completedTask('done')], {
      a2aTaskConverter: () => undefined,
    });

    expect(await drain(agent, createContext())).toEqual([]);
  });

  it('test_legacy_message_converter_returns_none_status_update', async () => {
    const {agent} = createAgent([statusUpdate('working')], {
      a2aStatusUpdateConverter: () => undefined,
    });

    expect(await drain(agent, createContext())).toEqual([]);
  });

  it('test_legacy_message_converter_returns_none_artifact_update', async () => {
    const artifact = vi.fn<A2AArtifactUpdateToEventConverter>(() => undefined);
    const {agent} = createAgent([artifactUpdate('chunk')], {
      a2aArtifactUpdateConverter: artifact,
    });

    expect(await drain(agent, createContext())).toEqual([]);
    expect(artifact).toHaveBeenCalledOnce();
  });
});

describe('RemoteA2AAgent converter slots', () => {
  it('yields what the message converter returns', async () => {
    const replacement = createEvent({author: 'custom', invocationId: 'inv'});
    const message = vi.fn<A2AMessageToEventConverter>(() => replacement);
    const frame = agentMessage('hi');
    const {agent} = createAgent([frame], {a2aMessageConverter: message});

    const events = await drain(agent, createContext());

    expect(events).toEqual([replacement]);
    expect(message).toHaveBeenCalledWith(
      frame,
      'invocation-123',
      'remote_agent',
      undefined,
      expect.any(Function),
    );
  });

  it('yields what the task converter returns', async () => {
    const replacement = createEvent({author: 'custom', invocationId: 'inv'});
    const {agent} = createAgent([completedTask('done')], {
      a2aTaskConverter: () => replacement,
    });

    expect(await drain(agent, createContext())).toEqual([replacement]);
  });

  it('yields what the status update converter returns', async () => {
    const replacement = createEvent({author: 'custom', invocationId: 'inv'});
    const {agent} = createAgent([statusUpdate('working')], {
      a2aStatusUpdateConverter: () => replacement,
    });

    expect(await drain(agent, createContext())).toEqual([replacement]);
  });

  it('yields what the artifact update converter returns', async () => {
    const replacement = createEvent({author: 'custom', invocationId: 'inv'});
    const {agent} = createAgent([artifactUpdate('chunk')], {
      a2aArtifactUpdateConverter: () => replacement,
    });

    expect(await drain(agent, createContext())).toEqual([replacement]);
  });

  it('hands the part converter to the default converters', async () => {
    const part = vi.fn<A2APartToGenAIPartConverter>(() => ({
      text: 'converted',
    }));
    const {agent} = createAgent([agentMessage('original')], {
      a2aPartConverter: part,
    });

    const events = await drain(agent, createContext());

    expect(part).toHaveBeenCalledOnce();
    expect(events[0].content?.parts).toEqual([{text: 'converted'}]);
  });

  it('drops a part its converter returns undefined for', async () => {
    const frame: Message = {
      kind: 'message',
      messageId: 'resp-1',
      role: 'agent',
      parts: [
        {kind: 'text', text: 'keep'},
        {kind: 'text', text: 'drop'},
      ],
    };
    const part: A2APartToGenAIPartConverter = (a2aPart) =>
      a2aPart.kind === 'text' && a2aPart.text === 'drop'
        ? undefined
        : {text: 'keep'};
    const {agent} = createAgent([frame], {a2aPartConverter: part});

    const events = await drain(agent, createContext());

    expect(events[0].content?.parts).toEqual([{text: 'keep'}]);
  });

  it('expands a part its converter returns an array for', async () => {
    const part: A2APartToGenAIPartConverter = () => [
      {text: 'one'},
      {text: 'two'},
    ];
    const {agent} = createAgent([agentMessage('original')], {
      a2aPartConverter: part,
    });

    const events = await drain(agent, createContext());

    expect(events[0].content?.parts).toEqual([{text: 'one'}, {text: 'two'}]);
  });

  it('produces the default conversion when no slot is set', async () => {
    const frame = agentMessage('hello there');
    const {agent} = createAgent([frame]);
    const {agent: overridden} = createAgent([frame], {
      a2aMessageConverter: undefined,
      a2aPartConverter: undefined,
    });

    const [defaults, explicitlyUnset] = await Promise.all([
      drain(agent, createContext()),
      drain(overridden, createContext()),
    ]);

    expect(defaults[0].content).toEqual({
      role: 'model',
      parts: [{text: 'hello there', thought: false}],
    });
    expect(explicitlyUnset[0].content).toEqual(defaults[0].content);
  });
});

describe('RemoteA2AAgent request interceptors', () => {
  it('puts requestMetadata on the send parameters', async () => {
    const interceptor: A2ARequestInterceptor = {
      beforeRequest: async (_ctx, request) => ({
        request,
        params: {requestMetadata: {tenant: 'acme'}},
      }),
    };
    const {agent, transport} = createAgent([agentMessage('hi')], {
      requestInterceptors: [interceptor],
    });

    await drain(agent, createContext());

    expect(transport.sentParams[0].metadata).toEqual({tenant: 'acme'});
  });

  it('puts headers on the streaming request options', async () => {
    const interceptor: A2ARequestInterceptor = {
      beforeRequest: async (_ctx, request) => ({
        request,
        params: {headers: {authorization: 'Bearer send'}},
      }),
    };
    const {agent, transport} = createAgent([agentMessage('hi')], {
      requestInterceptors: [interceptor],
    });

    await drain(agent, createContext());

    expect(transport.sentOptions[0]?.serviceParameters).toEqual({
      authorization: 'Bearer send',
    });
  });

  it('puts headers on the non-streaming request options', async () => {
    const card = createTestAgentCard({capabilities: {streaming: false}});
    const interceptor: A2ARequestInterceptor = {
      beforeRequest: async (_ctx, request) => ({
        request,
        params: {headers: {authorization: 'Bearer send'}},
      }),
    };
    const {agent, transport} = createAgent(
      [agentMessage('hi')],
      {requestInterceptors: [interceptor]},
      card,
    );

    await drain(agent, createContext());

    expect(transport.sentOptions[0]?.serviceParameters).toEqual({
      authorization: 'Bearer send',
    });
  });

  it('sends no request options when no interceptor supplies headers', async () => {
    const {agent, transport} = createAgent([agentMessage('hi')]);

    await drain(agent, createContext());

    expect(transport.sentOptions[0]).toBeUndefined();
  });

  it('replaces the outgoing message a before-request hook rewrites', async () => {
    const rewritten: Message = {
      kind: 'message',
      messageId: 'rewritten',
      role: 'user',
      parts: [{kind: 'text', text: 'rewritten'}],
    };
    const {agent, transport} = createAgent([agentMessage('hi')], {
      requestInterceptors: [
        {beforeRequest: async () => ({request: rewritten, params: {}})},
      ],
    });

    await drain(agent, createContext());

    expect(transport.sentParams[0].message).toBe(rewritten);
  });

  it('yields the event a before-request hook returns and sends nothing', async () => {
    const abort = createEvent({author: 'guard', invocationId: 'inv'});
    const {agent, transport} = createAgent([agentMessage('hi')], {
      requestInterceptors: [
        {beforeRequest: async () => ({request: abort, params: {}})},
      ],
    });

    const events = await drain(agent, createContext());

    expect(events).toEqual([abort]);
    expect(transport.sentParams).toHaveLength(0);
  });

  it('drops a frame whose after-request hook returns undefined', async () => {
    const {agent} = createAgent([agentMessage('hi')], {
      requestInterceptors: [{afterRequest: async () => undefined}],
    });

    expect(await drain(agent, createContext())).toEqual([]);
  });

  it('drops a frame whose after-request hook returns undefined on the non-streaming path', async () => {
    const card = createTestAgentCard({capabilities: {streaming: false}});
    const {agent} = createAgent(
      [agentMessage('hi')],
      {requestInterceptors: [{afterRequest: async () => undefined}]},
      card,
    );

    expect(await drain(agent, createContext())).toEqual([]);
  });

  it('replaces the event an after-request hook rewrites', async () => {
    const replacement = createEvent({author: 'audit', invocationId: 'inv'});
    const {agent} = createAgent([agentMessage('hi')], {
      requestInterceptors: [{afterRequest: async () => replacement}],
    });

    expect(await drain(agent, createContext())).toEqual([replacement]);
  });

  it('runs the existing callbacks around the new interceptors', async () => {
    const order: string[] = [];
    const config: Partial<RemoteA2AAgentConfig> = {
      beforeRequestCallbacks: [
        () => {
          order.push('beforeCallback');
        },
      ],
      afterRequestCallbacks: [
        () => {
          order.push('afterCallback');
        },
      ],
      requestInterceptors: [
        {
          beforeRequest: async (_ctx, request, params) => {
            order.push('beforeInterceptor');
            return {request, params};
          },
          afterRequest: async (_ctx, _response, event) => {
            order.push('afterInterceptor');
            return event;
          },
        },
      ],
    };
    const {agent} = createAgent([agentMessage('hi')], config);

    await drain(agent, createContext());

    expect(order).toEqual([
      'beforeCallback',
      'beforeInterceptor',
      'afterCallback',
      'afterInterceptor',
    ]);
  });

  it('runs the existing after-request callback on the non-streaming path', async () => {
    const card = createTestAgentCard({capabilities: {streaming: false}});
    const seen: string[] = [];
    const {agent} = createAgent(
      [agentMessage('hi')],
      {
        afterRequestCallbacks: [
          (_ctx, resp) => {
            seen.push(resp.kind);
          },
        ],
      },
      card,
    );

    await drain(agent, createContext());

    expect(seen).toEqual(['message']);
  });

  it('turns a rejecting hook into an error event', async () => {
    const {agent} = createAgent([agentMessage('hi')], {
      requestInterceptors: [
        {
          beforeRequest: async () => {
            throw new Error('hook failed');
          },
        },
      ],
    });

    const events = await drain(agent, createContext());

    expect(events).toHaveLength(1);
    expect(events[0].errorMessage).toBe('hook failed');
  });
});
