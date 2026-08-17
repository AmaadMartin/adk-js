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
  Event as AdkEvent,
  createEvent,
  InvocationContext,
  RemoteA2AAgent,
  RemoteA2AAgentConfig,
  Session,
  toGenAIPart,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

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

  describe('converter overrides', () => {
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

    it('routes a streaming task chunk through a2aTaskConverter', async () => {
      const converted = createEvent({
        author: 'test-agent',
        invocationId: 'test-invocation',
        content: {role: 'model', parts: [{text: 'converted'}]},
      });
      const a2aTaskConverter = vi.fn().mockReturnValue(converted);
      const a2aPartConverter = vi.fn(toGenAIPart);

      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: streamingCard,
        clientFactory: mockClientFactory,
        a2aTaskConverter,
        a2aPartConverter,
      });

      const chunk = {
        kind: 'task',
        id: 'task-1',
        contextId: 'ctx-1',
        status: {state: 'completed'},
      } as A2AStreamEventData;
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield chunk;
        })(),
      );

      const context = createMockContext({branch: 'coordinator.remote'});
      const events: AdkEvent[] = [];
      for await (const event of agent.runAsync(context)) {
        events.push(event);
      }

      expect(events.length).toBe(1);
      expect(events[0].content?.parts![0].text).toBe('converted');
      expect(a2aTaskConverter).toHaveBeenCalledTimes(1);
      expect(a2aTaskConverter).toHaveBeenCalledWith(
        chunk,
        'test-invocation',
        'test-agent',
        'coordinator.remote',
        a2aPartConverter,
      );
    });

    it('routes a non-streaming message response through a2aMessageConverter', async () => {
      const converted = createEvent({
        author: 'test-agent',
        invocationId: 'test-invocation',
        content: {role: 'model', parts: [{text: 'converted'}]},
      });
      const a2aMessageConverter = vi.fn().mockReturnValue(converted);
      const a2aPartConverter = vi.fn(toGenAIPart);

      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: {...streamingCard, capabilities: {streaming: false}},
        clientFactory: mockClientFactory,
        a2aMessageConverter,
        a2aPartConverter,
      });

      const response: Message = {
        kind: 'message',
        messageId: 'msg-1',
        role: 'agent',
        parts: [{kind: 'text', text: 'static response'}],
      };
      vi.mocked(mockClient.sendMessage).mockResolvedValue(response);

      const context = createMockContext({branch: 'coordinator.remote'});
      const events: AdkEvent[] = [];
      for await (const event of agent.runAsync(context)) {
        events.push(event);
      }

      expect(events.length).toBe(1);
      expect(events[0].content?.parts![0].text).toBe('converted');
      expect(a2aMessageConverter).toHaveBeenCalledTimes(1);
      expect(a2aMessageConverter).toHaveBeenCalledWith(
        response,
        'test-invocation',
        'test-agent',
        'coordinator.remote',
        a2aPartConverter,
      );
    });

    it('emits nothing for a chunk whose converter returns undefined and keeps later chunks', async () => {
      const a2aStatusUpdateConverter = vi.fn().mockReturnValue(undefined);

      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: streamingCard,
        clientFactory: mockClientFactory,
        a2aStatusUpdateConverter,
      });

      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield {
            kind: 'status-update',
            taskId: 'task-1',
            contextId: 'ctx-1',
            status: {
              state: 'working',
              message: {
                kind: 'message',
                messageId: 'msg-status',
                role: 'agent',
                parts: [{kind: 'text', text: 'suppressed'}],
              },
            },
            final: false,
          } as A2AStreamEventData;
          yield {
            kind: 'message',
            messageId: 'msg-after',
            role: 'agent',
            parts: [{kind: 'text', text: 'still flowing'}],
          } as A2AStreamEventData;
        })(),
      );

      const context = createMockContext();
      const events: AdkEvent[] = [];
      for await (const event of agent.runAsync(context)) {
        events.push(event);
      }

      expect(a2aStatusUpdateConverter).toHaveBeenCalledTimes(1);
      expect(events.length).toBe(1);
      expect(events[0].content?.parts![0].text).toBe('still flowing');
    });

    it('applies a2aPartConverter to a streaming chunk when no event converter is set', async () => {
      const agent = new RemoteA2AAgent({
        name: 'test-agent',
        agentCard: streamingCard,
        clientFactory: mockClientFactory,
        a2aPartConverter: (a2aPart) => {
          const genAIPart = toGenAIPart(a2aPart);
          return genAIPart.text
            ? {...genAIPart, text: genAIPart.text.toUpperCase()}
            : genAIPart;
        },
      });

      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield {
            kind: 'message',
            messageId: 'msg-part',
            role: 'agent',
            parts: [{kind: 'text', text: 'shout'}],
          } as A2AStreamEventData;
        })(),
      );

      const context = createMockContext();
      const events: AdkEvent[] = [];
      for await (const event of agent.runAsync(context)) {
        events.push(event);
      }

      expect(events.length).toBe(1);
      expect(events[0].content?.parts![0].text).toBe('SHOUT');
    });
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
});
