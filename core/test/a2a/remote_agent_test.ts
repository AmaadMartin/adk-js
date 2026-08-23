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
  A2AClientError,
  Event as AdkEvent,
  AgentCardResolutionError,
  createEvent,
  InvocationContext,
  isA2AClientError,
  isAgentCardResolutionError,
  RemoteA2AAgent,
  RemoteA2AAgentConfig,
  Session,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

type A2AStreamEventData =
  | Message
  | Task
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

vi.mock('@a2a-js/sdk/client', () => {
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
  return {Client, ClientFactory, DefaultAgentCardResolver};
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

  /** An A2A stream that fails on the first read. */
  const failingStream = async function* (
    error: unknown,
  ): AsyncGenerator<A2AStreamEventData, void, undefined> {
    yield* [];
    throw error;
  };

  const drain = async (
    events: AsyncIterable<AdkEvent>,
  ): Promise<AdkEvent[]> => {
    const collected: AdkEvent[] = [];
    for await (const event of events) {
      collected.push(event);
    }
    return collected;
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
  it('throws AgentCardResolutionError when neither agentCard nor client are provided', () => {
    let thrown: unknown;
    try {
      new RemoteA2AAgent({name: 'test'} as unknown as RemoteA2AAgentConfig);
    } catch (e: unknown) {
      thrown = e;
    }

    expect(isAgentCardResolutionError(thrown)).toBe(true);
    expect((thrown as AgentCardResolutionError).message).toBe(
      'Either AgentCard or Client must be provided',
    );
  });

  it('rejects with A2AClientError when the client factory fails', async () => {
    const inner = new Error('no transport matched the card');
    vi.mocked(mockClientFactory.createFromAgentCard).mockRejectedValue(inner);

    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: streamingCard,
      clientFactory: mockClientFactory,
    });

    const err = await drain(agent.runAsync(createMockContext())).catch(
      (e: unknown) => e,
    );

    expect(isA2AClientError(err)).toBe(true);
    expect((err as A2AClientError).message).toBe(
      'no transport matched the card',
    );
    expect((err as A2AClientError).cause).toBe(inner);
  });

  it('does not re-wrap a client factory failure that is already typed', async () => {
    const typed = new A2AClientError('already typed');
    vi.mocked(mockClientFactory.createFromAgentCard).mockRejectedValue(typed);

    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: streamingCard,
      clientFactory: mockClientFactory,
    });

    const err = await drain(agent.runAsync(createMockContext())).catch(
      (e: unknown) => e,
    );

    expect(err).toBe(typed);
  });

  it('rejects with AgentCardResolutionError when card resolution fails', async () => {
    vi.mocked(mockResolver.resolve).mockRejectedValue(new Error('bad card'));

    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: 'https://example.com/card.json',
      clientFactory: mockClientFactory,
    });

    const err = await drain(agent.runAsync(createMockContext())).catch(
      (e: unknown) => e,
    );

    expect(isAgentCardResolutionError(err)).toBe(true);
    expect(isA2AClientError(err)).toBe(false);
    expect((err as AgentCardResolutionError).message).toBe('bad card');
  });

  it('emits an error event with the original message when the stream fails', async () => {
    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: streamingCard,
      clientFactory: mockClientFactory,
    });
    vi.mocked(mockClient.sendMessageStream).mockReturnValue(
      failingStream(new Error('stream broke')),
    );

    const events = await drain(agent.runAsync(createMockContext()));

    expect(events.length).toBe(1);
    expect(events[0].errorMessage).toBe('stream broke');
    expect(events[0].turnComplete).toBe(true);
  });

  it('emits an error event with the original message when sendMessage fails', async () => {
    const card: AgentCard = {
      ...streamingCard,
      capabilities: {streaming: false},
    };
    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: card,
      clientFactory: mockClientFactory,
    });
    vi.mocked(mockClient.sendMessage).mockRejectedValue(
      new Error('send broke'),
    );

    const events = await drain(agent.runAsync(createMockContext()));

    expect(events.length).toBe(1);
    expect(events[0].errorMessage).toBe('send broke');
    expect(events[0].turnComplete).toBe(true);
  });

  it('does not label a per-chunk callback failure as a client error', async () => {
    const callbackError = new Error('callback broke');
    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: streamingCard,
      clientFactory: mockClientFactory,
      afterRequestCallbacks: [
        () => {
          throw callbackError;
        },
      ],
    });
    vi.mocked(mockClient.sendMessageStream).mockReturnValue(
      (async function* (): AsyncGenerator<A2AStreamEventData, void, void> {
        yield {
          kind: 'artifact-update',
          artifact: {parts: [{kind: 'text', text: 'response'}]},
        } as A2AStreamEventData;
      })(),
    );
    const logged: unknown[] = [];
    vi.spyOn(logger, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args[1]);
    });

    const events = await drain(agent.runAsync(createMockContext()));

    expect(events.length).toBe(1);
    expect(events[0].errorMessage).toBe('callback broke');
    expect(logged).toEqual([callbackError]);
    expect(isA2AClientError(logged[0])).toBe(false);
  });

  it('emits a readable error event when the client throws a non-Error value', async () => {
    const agent = new RemoteA2AAgent({
      name: 'test-agent',
      agentCard: streamingCard,
      clientFactory: mockClientFactory,
    });
    vi.mocked(mockClient.sendMessageStream).mockReturnValue(
      failingStream('plain string'),
    );

    const events = await drain(agent.runAsync(createMockContext()));

    expect(events.length).toBe(1);
    expect(events[0].errorMessage).toBe('plain string');
  });
});
