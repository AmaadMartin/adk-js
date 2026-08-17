/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentCard,
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {
  Client,
  ClientFactory,
  DefaultAgentCardResolver,
} from '@a2a-js/sdk/client';
import {
  A2A_SESSION_STATE_CONTEXT_KEY,
  Event as AdkEvent,
  createEvent,
  createSession,
  InvocationContext,
  RemoteA2AAgent,
  RemoteA2AAgentConfig,
  Session,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

type A2AStreamEventData =
  | Message
  | Task
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

// `actual` is spread in because core instantiates ClientCallContextKey, also
// exported from this module, at module load.
vi.mock('@a2a-js/sdk/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@a2a-js/sdk/client')>();
  const DefaultAgentCardResolver = vi.fn().mockImplementation(() => ({
    resolve: vi.fn(),
  }));
  const Client = vi.fn().mockImplementation(() => ({
    sendMessageStream: vi.fn(),
    sendMessage: vi.fn(),
  }));
  const ClientFactory = vi.fn().mockImplementation(() => ({
    createFromAgentCard: vi.fn(),
  }));
  return {...actual, Client, ClientFactory, DefaultAgentCardResolver};
});

describe('A2ARemoteAgent', () => {
  let mockClient: Client;
  let mockClientFactory: ClientFactory;
  let mockResolver: DefaultAgentCardResolver;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      sendMessageStream: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as Client;

    mockClientFactory = {
      createFromAgentCard: vi.fn().mockResolvedValue(mockClient),
    } as unknown as ClientFactory;

    mockResolver = {
      resolve: vi.fn(),
    } as unknown as DefaultAgentCardResolver;

    // Reset mocks to return our instances if constructors are called
    vi.mocked(ClientFactory).mockImplementation(() => mockClientFactory);
    vi.mocked(DefaultAgentCardResolver).mockImplementation(() => mockResolver);
  });

  const createMockContext = (overrides = {}): InvocationContext => {
    return {
      invocationId: 'test-invocation',
      session: {
        id: 'test-session',
        userId: 'test-user',
        appName: 'test-app',
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'hello'}]},
          }),
        ],
        state: {},
      } as unknown as Session,
      ...overrides,
    } as unknown as InvocationContext;
  };

  it('should throw if neither agentCard nor client are provided', () => {
    expect(
      () =>
        new RemoteA2AAgent({name: 'test'} as unknown as RemoteA2AAgentConfig),
    ).toThrow('Either AgentCard or Client must be provided');
  });

  it('should resolve card from URL and send message streaming', async () => {
    const card: AgentCard = {
      name: 'Remote',
      description: 'test',
      protocolVersion: '1.0',
      defaultInputModes: [],
      defaultOutputModes: [],
      capabilities: {streaming: true},
      skills: [],
      url: 'https://example.com',
      version: '1.0',
    };
    vi.mocked(mockResolver.resolve).mockResolvedValue(card);

    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: 'https://example.com/card.json',
      clientFactory: mockClientFactory,
    });

    const mockStream = async function* () {
      yield {
        kind: 'artifact-update',
        artifact: {parts: [{kind: 'text', text: 'response'}]},
      } as A2AStreamEventData;
    };
    vi.mocked(mockClient.sendMessageStream).mockReturnValue(mockStream());

    const context = createMockContext();
    const events: AdkEvent[] = [];

    for await (const event of agent.runAsync(context)) {
      events.push(event);
    }

    expect(mockResolver.resolve).toHaveBeenCalledWith(
      'https://example.com/card.json',
    );
    expect(mockClientFactory.createFromAgentCard).toHaveBeenCalledWith(card);
    expect(mockClient.sendMessageStream).toHaveBeenCalled();
    expect(events.length).toBe(1);
    expect(events[0].content?.parts![0].text).toBe('response');
  });

  it('should aggregate partial events and emit final event when lastChunk is true', async () => {
    const card: AgentCard = {
      name: 'Remote',
      description: 'test',
      protocolVersion: '1.0',
      defaultInputModes: [],
      defaultOutputModes: [],
      capabilities: {streaming: true},
      skills: [],
      url: 'https://example.com',
      version: '1.0',
    };
    vi.mocked(mockResolver.resolve).mockResolvedValue(card);

    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: card,
      clientFactory: mockClientFactory,
    });

    const mockStream = async function* () {
      yield {
        kind: 'artifact-update',
        contextId: 'test-context',
        append: true,
        lastChunk: false,
        artifact: {
          artifactId: 'art-1',
          parts: [{kind: 'text', text: 'part 1'}],
        },
      } as A2AStreamEventData;
      yield {
        kind: 'artifact-update',
        contextId: 'test-context',
        append: true,
        lastChunk: true,
        artifact: {
          artifactId: 'art-1',
          parts: [{kind: 'text', text: ' part 2'}],
        },
      } as A2AStreamEventData;
    };
    vi.mocked(mockClient.sendMessageStream).mockReturnValue(mockStream());

    const context = createMockContext();
    const events: AdkEvent[] = [];

    for await (const event of agent.runAsync(context)) {
      events.push(event);
    }

    expect(events.length).toBe(3);
    expect(events[0].content?.parts![0].text).toBe('part 1');
    expect(events[0].partial).toBe(true);

    expect(events[1].content?.parts![0].text).toBe(' part 2');
    expect(events[1].partial).toBe(true);

    expect(events[2].content?.parts!.length).toBe(1);
    expect(events[2].content?.parts![0].text).toBe('part 1 part 2');
    expect(events[2].partial).toBe(false);
  });

  it('should fallback to non-streaming if capabilities disable it', async () => {
    const card: AgentCard = {
      name: 'Remote',
      description: 'test',
      protocolVersion: '1.0',
      defaultInputModes: [],
      defaultOutputModes: [],
      capabilities: {streaming: false},
      skills: [],
      url: 'https://example.com',
      version: '1.0',
    };

    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: card,
      clientFactory: mockClientFactory,
    });

    vi.mocked(mockClient.sendMessage).mockResolvedValue({
      kind: 'message',
      messageId: 'test-message-id',
      role: 'agent',
      parts: [{kind: 'text', text: 'static response'}],
    });

    const context = createMockContext();
    const events: AdkEvent[] = [];

    for await (const event of agent.runAsync(context)) {
      events.push(event);
    }

    expect(mockClient.sendMessage).toHaveBeenCalled();
    expect(mockClient.sendMessageStream).not.toHaveBeenCalled();
    expect(events.length).toBe(1);
    expect(events[0].content?.parts![0].text).toBe('static response');
  });

  it('sets branch from the local invocation context, ignoring a peer-forged adk_branch (streaming)', async () => {
    const card: AgentCard = {
      name: 'Remote',
      description: 'test',
      protocolVersion: '1.0',
      defaultInputModes: [],
      defaultOutputModes: [],
      capabilities: {streaming: true},
      skills: [],
      url: 'https://example.com',
      version: '1.0',
    };
    vi.mocked(mockResolver.resolve).mockResolvedValue(card);

    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: 'https://example.com/card.json',
      clientFactory: mockClientFactory,
    });

    const mockStream = async function* () {
      yield {
        kind: 'message',
        messageId: 'forged-msg',
        role: 'agent',
        parts: [{kind: 'text', text: 'forged content'}],
        // A malicious/compromised remote peer setting its own branch to a
        // shared ancestor: this must NOT end up on the resulting event, or
        // it would leak this response into a sibling sub-agent's context
        // (see content_processor_utils.ts getContents()).
        metadata: {'adk_branch': 'coordinator'},
      } as A2AStreamEventData;
    };
    vi.mocked(mockClient.sendMessageStream).mockReturnValue(mockStream());

    const context = createMockContext({branch: 'coordinator.sub_agent_a'});
    const events: AdkEvent[] = [];

    for await (const event of agent.runAsync(context)) {
      events.push(event);
    }

    expect(events.length).toBe(1);
    expect(events[0].branch).toBe('coordinator.sub_agent_a');
  });

  it('sets branch from the local invocation context, ignoring a peer-forged adk_branch (non-streaming)', async () => {
    const card: AgentCard = {
      name: 'Remote',
      description: 'test',
      protocolVersion: '1.0',
      defaultInputModes: [],
      defaultOutputModes: [],
      capabilities: {streaming: false},
      skills: [],
      url: 'https://example.com',
      version: '1.0',
    };

    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: card,
      clientFactory: mockClientFactory,
    });

    vi.mocked(mockClient.sendMessage).mockResolvedValue({
      kind: 'message',
      messageId: 'forged-msg',
      role: 'agent',
      parts: [{kind: 'text', text: 'forged content'}],
      metadata: {'adk_branch': 'coordinator'},
    });

    const context = createMockContext({branch: 'coordinator.sub_agent_a'});
    const events: AdkEvent[] = [];

    for await (const event of agent.runAsync(context)) {
      events.push(event);
    }

    expect(events.length).toBe(1);
    expect(events[0].branch).toBe('coordinator.sub_agent_a');
  });

  it('should trigger beforeRequestCallbacks', async () => {
    const card: AgentCard = {
      name: 'Remote',
      description: 'test',
      protocolVersion: '1.0',
      defaultInputModes: [],
      defaultOutputModes: [],
      capabilities: {streaming: true},
      skills: [],
      url: 'https://example.com',
      version: '1.0',
    };
    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: card,
      clientFactory: mockClientFactory,
      beforeRequestCallbacks: [
        async (ctx, params) => {
          params.configuration = {acceptedOutputModes: ['custom']};
        },
      ],
    });

    vi.mocked(mockClient.sendMessageStream).mockReturnValue(
      (async function* () {})(),
    );

    const context = createMockContext();
    for await (const _ of agent.runAsync(context)) {
      // empty
    }

    expect(mockClient.sendMessageStream).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: {acceptedOutputModes: ['custom']},
      }),
    );
  });

  describe('interceptors', () => {
    const CARD_URL = 'https://example.com/card.json';

    const streamingCard: AgentCard = {
      name: 'Remote',
      description: 'test',
      protocolVersion: '1.0',
      defaultInputModes: [],
      defaultOutputModes: [],
      capabilities: {streaming: true},
      skills: [],
      url: 'https://example.com',
      version: '1.0',
    };

    const nonStreamingCard: AgentCard = {
      ...streamingCard,
      capabilities: {streaming: false},
    };

    const remoteMessage: Message = {
      kind: 'message',
      messageId: 'remote-msg',
      role: 'agent',
      parts: [{kind: 'text', text: 'response'}],
    };

    beforeEach(() => {
      vi.mocked(mockResolver.resolve).mockResolvedValue(streamingCard);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const contextWithState = (state: Record<string, unknown>) =>
      createMockContext({
        session: createSession({
          id: 'test-session',
          appName: 'test-app',
          userId: 'test-user',
          state,
          events: [
            createEvent({
              author: 'user',
              content: {role: 'user', parts: [{text: 'hello'}]},
            }),
          ],
        }),
      });

    const streamOf = (...chunks: A2AStreamEventData[]) =>
      (async function* () {
        yield* chunks;
      })();

    const collect = async (
      agent: RemoteA2AAgent,
      context: InvocationContext,
    ): Promise<AdkEvent[]> => {
      const events: AdkEvent[] = [];
      for await (const event of agent.runAsync(context)) {
        events.push(event);
      }
      return events;
    };

    /** Returns the Authorization header the nth resolver would send. */
    const authHeaderOfResolver = async (index: number): Promise<string> => {
      const fetchSpy = vi.fn().mockResolvedValue(new Response('{}'));
      vi.stubGlobal('fetch', fetchSpy);
      const options = vi.mocked(DefaultAgentCardResolver).mock.calls[index][0];
      if (!options?.fetchImpl) {
        expect.fail(`resolver ${index} was built without a fetchImpl`);
      }
      await options.fetchImpl(CARD_URL);
      const [, init] = fetchSpy.mock.calls[0];
      return new Headers(init?.headers).get('Authorization') ?? '';
    };

    it('keeps the call shape unchanged when no interceptor is configured', async () => {
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: CARD_URL,
        clientFactory: mockClientFactory,
      });
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(streamOf());

      await collect(agent, createMockContext());
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(streamOf());
      await collect(agent, createMockContext());

      expect(
        vi.mocked(mockClient.sendMessageStream).mock.calls[0],
      ).toHaveLength(1);
      expect(mockResolver.resolve).toHaveBeenCalledTimes(1);
    });

    it('sends the request metadata an interceptor sets', async () => {
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: streamingCard,
        clientFactory: mockClientFactory,
        requestInterceptors: [
          {
            beforeRequest: async (_ctx, request, params) => [
              request,
              {...params, requestMetadata: {tenant: 'acme'}},
            ],
          },
        ],
      });
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(streamOf());

      await collect(agent, createMockContext());

      const [params] = vi.mocked(mockClient.sendMessageStream).mock.calls[0];
      expect(params.metadata).toEqual({tenant: 'acme'});
    });

    it('omits the options argument when no call context survives', async () => {
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: streamingCard,
        clientFactory: mockClientFactory,
        requestInterceptors: [
          {beforeRequest: async (_ctx, request) => [request, {}]},
        ],
      });
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(streamOf());

      await collect(agent, createMockContext());

      expect(
        vi.mocked(mockClient.sendMessageStream).mock.calls[0],
      ).toHaveLength(1);
    });

    it('sends the message an interceptor substitutes', async () => {
      const replacement: Message = {
        kind: 'message',
        messageId: 'replaced',
        role: 'user',
        parts: [{kind: 'text', text: 'rewritten'}],
      };
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: streamingCard,
        clientFactory: mockClientFactory,
        requestInterceptors: [
          {
            beforeRequest: async (_ctx, _request, params) => [
              replacement,
              params,
            ],
          },
        ],
      });
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(streamOf());

      await collect(agent, createMockContext());

      const [params] = vi.mocked(mockClient.sendMessageStream).mock.calls[0];
      expect(params.message).toBe(replacement);
    });

    it('publishes the session state on the client call context', async () => {
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: streamingCard,
        clientFactory: mockClientFactory,
        requestInterceptors: [
          {beforeRequest: async (_ctx, request, params) => [request, params]},
        ],
      });
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(streamOf());

      await collect(agent, contextWithState({token: 'session-a'}));

      const [, options] = vi.mocked(mockClient.sendMessageStream).mock.calls[0];
      if (!options?.context) {
        expect.fail('sendMessageStream got no client call context');
      }
      expect(A2A_SESSION_STATE_CONTEXT_KEY.get(options.context)).toEqual({
        token: 'session-a',
      });
    });

    it('aborts the call when an interceptor returns an event', async () => {
      const abortEvent = createEvent({
        author: 'test-agent',
        content: {role: 'model', parts: [{text: 'cached answer'}]},
      });
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: streamingCard,
        clientFactory: mockClientFactory,
        requestInterceptors: [
          {
            beforeRequest: async (_ctx, _request, params) => [
              abortEvent,
              params,
            ],
          },
        ],
      });

      const events = await collect(agent, createMockContext());

      expect(events).toEqual([abortEvent]);
      expect(mockClient.sendMessageStream).not.toHaveBeenCalled();
    });

    it('emits what afterRequest returns and drops what it discards', async () => {
      const replacement = createEvent({
        author: 'test-agent',
        content: {role: 'model', parts: [{text: 'observed'}]},
      });
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: streamingCard,
        clientFactory: mockClientFactory,
        requestInterceptors: [
          {
            afterRequest: async (_ctx, _response, event) =>
              event.content?.parts?.[0].text === 'drop'
                ? undefined
                : replacement,
          },
        ],
      });
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        streamOf(
          {...remoteMessage, parts: [{kind: 'text', text: 'drop'}]},
          {...remoteMessage, parts: [{kind: 'text', text: 'keep'}]},
        ),
      );

      const events = await collect(agent, createMockContext());

      expect(events).toEqual([replacement]);
    });

    it('sends the card interceptor headers on the card fetch only', async () => {
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: CARD_URL,
        clientFactory: mockClientFactory,
        cardRequestInterceptors: [
          {
            beforeRequest: async (ctx) => ({
              headers: {Authorization: `Bearer ${ctx.session.state['token']}`},
            }),
          },
        ],
      });
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(streamOf());

      await collect(agent, contextWithState({token: 'session-a'}));

      expect(await authHeaderOfResolver(0)).toBe('Bearer session-a');
      expect(
        vi.mocked(mockClient.sendMessageStream).mock.calls[0],
      ).toHaveLength(1);
    });

    it('refetches the card per invocation without leaking it across sessions', async () => {
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: CARD_URL,
        clientFactory: mockClientFactory,
        cardRequestInterceptors: [
          {
            beforeRequest: async (ctx) => ({
              headers: {Authorization: `Bearer ${ctx.session.state['token']}`},
            }),
          },
        ],
      });

      vi.mocked(mockClient.sendMessageStream).mockReturnValue(streamOf());
      await collect(agent, contextWithState({token: 'session-a'}));
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(streamOf());
      await collect(agent, contextWithState({token: 'session-b'}));

      expect(mockResolver.resolve).toHaveBeenCalledTimes(2);
      expect(await authHeaderOfResolver(0)).toBe('Bearer session-a');
      expect(await authHeaderOfResolver(1)).toBe('Bearer session-b');
    });

    it('reuses a caller-supplied client on the per-invocation card path', async () => {
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: CARD_URL,
        client: mockClient,
        clientFactory: mockClientFactory,
        cardRequestInterceptors: [
          {beforeRequest: async () => ({headers: {Authorization: 'Bearer x'}})},
        ],
      });
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(streamOf());

      await collect(agent, createMockContext());

      expect(mockResolver.resolve).toHaveBeenCalledTimes(1);
      expect(mockClientFactory.createFromAgentCard).not.toHaveBeenCalled();
      expect(mockClient.sendMessageStream).toHaveBeenCalledTimes(1);
    });

    it('never invokes a card interceptor for a loaded card', async () => {
      const beforeRequest = vi.fn();
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: streamingCard,
        clientFactory: mockClientFactory,
        cardRequestInterceptors: [{beforeRequest}],
      });

      vi.mocked(mockClient.sendMessageStream).mockReturnValue(streamOf());
      await collect(agent, createMockContext());
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(streamOf());
      await collect(agent, createMockContext());

      expect(beforeRequest).not.toHaveBeenCalled();
      expect(mockClientFactory.createFromAgentCard).toHaveBeenCalledTimes(1);
    });

    it('applies the interceptors on the non-streaming branch', async () => {
      const replacement = createEvent({
        author: 'test-agent',
        content: {role: 'model', parts: [{text: 'observed'}]},
      });
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: nonStreamingCard,
        clientFactory: mockClientFactory,
        requestInterceptors: [
          {
            beforeRequest: async (_ctx, request, params) => [
              request,
              {...params, requestMetadata: {tenant: 'acme'}},
            ],
            afterRequest: async () => replacement,
          },
        ],
      });
      vi.mocked(mockClient.sendMessage).mockResolvedValue(remoteMessage);

      const events = await collect(agent, contextWithState({token: 'a'}));

      expect(events).toEqual([replacement]);
      const [params, options] = vi.mocked(mockClient.sendMessage).mock.calls[0];
      expect(params.metadata).toEqual({tenant: 'acme'});
      if (!options?.context) {
        expect.fail('sendMessage got no client call context');
      }
      expect(A2A_SESSION_STATE_CONTEXT_KEY.get(options.context)).toEqual({
        token: 'a',
      });
    });

    it('drops a non-streaming event that afterRequest discards', async () => {
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: nonStreamingCard,
        clientFactory: mockClientFactory,
        requestInterceptors: [{afterRequest: async () => undefined}],
      });
      vi.mocked(mockClient.sendMessage).mockResolvedValue(remoteMessage);

      expect(await collect(agent, createMockContext())).toEqual([]);
    });

    it('emits nothing when a non-streaming response converts to no event', async () => {
      const afterRequest = vi.fn();
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: nonStreamingCard,
        clientFactory: mockClientFactory,
        requestInterceptors: [{afterRequest}],
      });
      vi.mocked(mockClient.sendMessage).mockResolvedValue({
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: {state: 'working'},
      });

      expect(await collect(agent, createMockContext())).toEqual([]);
      expect(afterRequest).not.toHaveBeenCalled();
    });

    it('aborts the non-streaming call when an interceptor returns an event', async () => {
      const abortEvent = createEvent({author: 'test-agent'});
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: nonStreamingCard,
        clientFactory: mockClientFactory,
        requestInterceptors: [
          {
            beforeRequest: async (_ctx, _request, params) => [
              abortEvent,
              params,
            ],
          },
        ],
      });

      expect(await collect(agent, createMockContext())).toEqual([abortEvent]);
      expect(mockClient.sendMessage).not.toHaveBeenCalled();
    });
  });
});
