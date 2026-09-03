/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart, AgentCard} from '@a2a-js/sdk';
import {Client, ClientFactory, RequestOptions} from '@a2a-js/sdk/client';
import {
  A2ARequestInterceptor,
  Event as AdkEvent,
  createEvent,
  DEFAULT_A2A_TIMEOUT_MS,
  InvocationContext,
  RemoteA2AAgent,
  RemoteA2AAgentConfig,
  Session,
  toA2APart,
} from '@google/adk';
import {Part as GenAIPart} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const CARD_URL = 'https://peer.example.com';

const CARD: AgentCard = {
  name: 'peer',
  description: 'the peer',
  protocolVersion: '0.3.0',
  version: '1.0.0',
  url: 'https://peer.example.com/a2a',
  skills: [],
  capabilities: {streaming: true},
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
};

interface Harness {
  cardRequests: Headers[];
  sendCalls: Array<RequestOptions | undefined>;
  client: Client;
  clientFactory: ClientFactory;
  fetchImpl: typeof fetch;
}

function createHarness(card: AgentCard = CARD): Harness {
  const cardRequests: Headers[] = [];
  const sendCalls: Array<RequestOptions | undefined> = [];
  const client = {
    sendMessageStream: vi.fn((_params, options: RequestOptions | undefined) => {
      sendCalls.push(options);
      return (async function* () {
        yield {
          kind: 'message',
          messageId: 'm-1',
          role: 'agent',
          parts: [{kind: 'text', text: 'pong'}],
        };
      })();
    }),
    sendMessage: vi.fn(),
  } as unknown as Client;
  const clientFactory = {
    createFromAgentCard: vi.fn().mockResolvedValue(client),
  } as unknown as ClientFactory;
  const fetchImpl: typeof fetch = async (_input, init) => {
    cardRequests.push(new Headers(init?.headers));
    return new Response(JSON.stringify(card), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  };
  return {cardRequests, sendCalls, client, clientFactory, fetchImpl};
}

function createContext(
  events: AdkEvent[] = [
    createEvent({
      author: 'user',
      content: {role: 'user', parts: [{text: 'hi'}]},
    }),
  ],
  overrides: Partial<InvocationContext> = {},
): InvocationContext {
  return {
    invocationId: 'inv-1',
    session: {
      id: 's-1',
      userId: 'u-1',
      appName: 'app-1',
      state: {},
      events,
    } as unknown as Session,
    ...overrides,
  } as unknown as InvocationContext;
}

async function collect(
  agent: RemoteA2AAgent,
  ctx: InvocationContext,
): Promise<AdkEvent[]> {
  const events: AdkEvent[] = [];
  for await (const event of agent.runAsync(ctx)) {
    events.push(event);
  }
  return events;
}

function agentWith(
  harness: Harness,
  overrides: Partial<RemoteA2AAgentConfig> = {},
): RemoteA2AAgent {
  return new RemoteA2AAgent({
    name: 'peer_agent',
    agentCard: CARD_URL,
    clientFactory: harness.clientFactory,
    fetchImpl: harness.fetchImpl,
    ...overrides,
  });
}

describe('RemoteA2AAgent lifecycle', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('sends a deadline signal with every request', async () => {
    await collect(agentWith(harness), createContext());

    expect(harness.sendCalls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(harness.sendCalls[0]?.signal?.aborted).toBe(false);
  });

  it('aborts the request once the timeout elapses', async () => {
    let observed: AbortSignal | undefined;
    vi.mocked(harness.client.sendMessageStream).mockImplementation(
      (_params, options) => {
        observed = options?.signal;
        return (async function* () {
          await new Promise<void>((resolve) => {
            observed?.addEventListener('abort', () => {
              resolve();
            });
          });
          yield* [];
        })();
      },
    );

    await collect(agentWith(harness, {timeoutMs: 5}), createContext());

    expect(observed?.aborted).toBe(true);
  });

  it('aborts the request when the invocation aborts', async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    vi.mocked(harness.client.sendMessageStream).mockImplementation(
      (_params, options) => {
        observed = options?.signal;
        controller.abort();
        return (async function* () {})();
      },
    );

    await collect(
      agentWith(harness),
      createContext(undefined, {abortSignal: controller.signal}),
    );

    expect(observed?.aborted).toBe(true);
  });

  it('applies the default deadline when the caller sets none', () => {
    expect(DEFAULT_A2A_TIMEOUT_MS).toBe(600_000);
  });

  it('reports a transport failure as an error event', async () => {
    vi.mocked(harness.client.sendMessageStream).mockImplementation(() => {
      throw new Error('connection reset');
    });

    const events = await collect(agentWith(harness), createContext());

    expect(events).toHaveLength(1);
    expect(events[0].errorMessage).toBe('A2A request failed: connection reset');
  });

  it('reports a card that fails validation as an init failure', async () => {
    const badHarness = createHarness({
      ...CARD,
      url: 'https://evil.example.com/a2a',
    });

    const events = await collect(agentWith(badHarness), createContext());

    expect(events).toHaveLength(1);
    expect(events[0].errorMessage).toContain(
      'Failed to initialize remote A2A agent',
    );
    expect(badHarness.client.sendMessageStream).not.toHaveBeenCalled();
  });

  it('re-validates a rejected card on the next call', async () => {
    const badHarness = createHarness({
      ...CARD,
      url: 'https://evil.example.com/a2a',
    });
    const agent = agentWith(badHarness);

    await collect(agent, createContext());
    await collect(agent, createContext());

    expect(badHarness.cardRequests).toHaveLength(2);
  });

  it('emits an empty event when there is nothing to send', async () => {
    const events = await collect(
      agentWith(harness),
      createContext([createEvent({author: 'peer_agent'})]),
    );

    expect(events).toHaveLength(1);
    expect(events[0].content).toEqual({});
    expect(harness.client.sendMessageStream).not.toHaveBeenCalled();
  });

  it('reports an empty session as an error event', async () => {
    const events = await collect(agentWith(harness), createContext([]));

    expect(events).toHaveLength(1);
    expect(events[0].errorMessage).toBe('No events in session to send');
  });

  it('emits the event an interceptor returned instead of sending', async () => {
    const replacement = createEvent({
      author: 'peer_agent',
      errorMessage: 'blocked by policy',
    });
    const blocking: A2ARequestInterceptor = {
      beforeRequest: async (_ctx, _request, params) => ({
        request: replacement,
        params,
      }),
    };

    const events = await collect(
      agentWith(harness, {requestInterceptors: [blocking]}),
      createContext(),
    );

    expect(events).toEqual([replacement]);
    expect(harness.client.sendMessageStream).not.toHaveBeenCalled();
  });

  it('releases the card and client it resolved on close', async () => {
    const agent = agentWith(harness);

    await collect(agent, createContext());
    agent.close();
    agent.close();
    await collect(agent, createContext());

    expect(harness.cardRequests).toHaveLength(2);
    expect(harness.clientFactory.createFromAgentCard).toHaveBeenCalledTimes(2);
  });

  it('keeps a client the caller supplied', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD,
      client: harness.client,
    });

    await collect(agent, createContext());
    agent.close();
    await collect(agent, createContext());

    expect(harness.client.sendMessageStream).toHaveBeenCalledTimes(2);
  });

  it('throws for an empty agent card string', () => {
    expect(
      () => new RemoteA2AAgent({name: 'peer_agent', agentCard: '   '}),
    ).toThrow('agentCard string cannot be empty');
  });

  it('adopts the description a directly supplied card carries', () => {
    const agent = new RemoteA2AAgent({name: 'peer_agent', agentCard: CARD});

    expect(agent.description).toBe('the peer');
  });

  it('never overwrites an explicit description', async () => {
    const agent = agentWith(harness, {description: 'mine'});

    await collect(agent, createContext());

    expect(agent.description).toBe('mine');
  });

  it('fences a description adopted from a network card', async () => {
    const agent = agentWith(harness);

    await collect(agent, createContext());

    expect(agent.description).toContain('<<<BEGIN_QUOTED_AGENT_CONTENT>>>');
    expect(agent.description).toContain('the peer');
  });

  it('advertises the new integration extension when useLegacy is false', async () => {
    await collect(agentWith(harness, {useLegacy: false}), createContext());

    expect(harness.sendCalls[0]?.serviceParameters).toEqual({
      'X-A2A-Extensions':
        'https://google.github.io/adk-docs/a2a/a2a-extension/',
    });
  });

  it('keeps the legacy integration by default', async () => {
    await collect(agentWith(harness), createContext());

    expect(harness.sendCalls[0]?.serviceParameters).toBeUndefined();
  });

  it('attaches the metadata the provider returns', async () => {
    await collect(
      agentWith(harness, {
        metadata: {ignored: true},
        a2aRequestMetaProvider: (_ctx, request) => ({
          messageId: request.messageId,
        }),
      }),
      createContext(),
    );

    const [params] = vi.mocked(harness.client.sendMessageStream).mock.calls[0];
    expect(params.metadata).toEqual({messageId: params.message.messageId});
  });

  it('drops an event an afterRequest interceptor rejects', async () => {
    const drop: A2ARequestInterceptor = {afterRequest: async () => undefined};

    const events = await collect(
      agentWith(harness, {requestInterceptors: [drop]}),
      createContext(),
    );

    expect(events).toHaveLength(0);
    expect(harness.client.sendMessageStream).toHaveBeenCalled();
  });

  it('adopts an empty description from a card that carries none', () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: {...CARD, description: ''},
    });

    expect(agent.description).toBe('');
  });

  it('uses a supplied client without building one', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      client: harness.client,
      fetchImpl: harness.fetchImpl,
    });

    await collect(agent, createContext());

    expect(harness.client.sendMessageStream).toHaveBeenCalled();
    expect(harness.clientFactory.createFromAgentCard).not.toHaveBeenCalled();
  });

  it('adopts nothing from a fetched card that omits its description', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          name: 'peer',
          protocolVersion: '0.3.0',
          version: '1.0.0',
          url: 'https://peer.example.com/a2a',
          skills: [],
          capabilities: {streaming: true},
          defaultInputModes: ['text'],
          defaultOutputModes: ['text'],
        }),
        {status: 200, headers: {'content-type': 'application/json'}},
      );
    const agent = agentWith(harness, {fetchImpl});

    await collect(agent, createContext());

    expect(agent.description).toBe('');
  });

  it('carries the task and context ids of the call being resumed', async () => {
    const call = createEvent({
      author: 'peer_agent',
      customMetadata: {'a2a:task_id': 'task-9', 'a2a:context_id': 'ctx-9'},
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'fc-1', name: 'ask', args: {}}}],
      },
    });
    const answer = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-1',
              name: 'ask',
              response: {result: 'y'},
            },
          },
        ],
      },
    });

    await collect(agentWith(harness), createContext([call, answer]));

    const [params] = vi.mocked(harness.client.sendMessageStream).mock.calls[0];
    expect(params.message.taskId).toBe('task-9');
    expect(params.message.contextId).toBe('ctx-9');
  });

  it('builds a client with the default factory when none is supplied', async () => {
    const stub = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', stub);
    const agent = new RemoteA2AAgent({name: 'peer_agent', agentCard: CARD});

    const events = await collect(agent, createContext());

    expect(events[0].errorMessage).toContain('A2A request failed');
    vi.unstubAllGlobals();
  });

  it('works with a client and no agent card', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      client: harness.client,
    });

    const events = await collect(agent, createContext());

    expect(events[0].content?.parts?.[0].text).toBe('pong');
    expect(harness.cardRequests).toHaveLength(0);
  });

  it('still refuses live mode', async () => {
    const live = agentWith(harness).runLive(createContext());

    await expect(live.next()).rejects.toThrow('Live mode is not supported');
  });
});

describe('RemoteA2AAgent converters', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('uses the configured outbound converter for every part', async () => {
    const seen: GenAIPart[] = [];
    const genaiPartConverter = (part: GenAIPart): A2APart => {
      seen.push(part);
      return {kind: 'text', text: 'rewritten'};
    };

    await collect(agentWith(harness, {genaiPartConverter}), createContext());

    const [params] = vi.mocked(harness.client.sendMessageStream).mock.calls[0];
    expect(seen).toHaveLength(1);
    expect(params.message.parts).toEqual([
      {kind: 'text', text: 'rewritten', metadata: {is_user_input: true}},
    ]);
  });

  it('expands an outbound converter that returns several parts', async () => {
    const genaiPartConverter = (part: GenAIPart): A2APart[] => [
      toA2APart(part),
      {kind: 'text', text: 'extra'},
    ];

    await collect(agentWith(harness, {genaiPartConverter}), createContext());

    const [params] = vi.mocked(harness.client.sendMessageStream).mock.calls[0];
    expect(params.message.parts).toHaveLength(2);
  });

  it('drops an outbound part the converter cannot convert', async () => {
    const events = await collect(
      agentWith(harness, {genaiPartConverter: () => undefined}),
      createContext(),
    );

    expect(events[0].content).toEqual({});
    expect(harness.client.sendMessageStream).not.toHaveBeenCalled();
  });

  it('uses the configured inbound converter', async () => {
    const events = await collect(
      agentWith(harness, {
        a2aPartConverter: () => ({text: 'converted inbound'}),
      }),
      createContext(),
    );

    expect(events[0].content?.parts?.[0].text).toBe('converted inbound');
  });

  it('drops an inbound part the converter cannot convert', async () => {
    const events = await collect(
      agentWith(harness, {a2aPartConverter: () => undefined}),
      createContext(),
    );

    expect(events).toHaveLength(1);
    expect(events[0].content).toBeUndefined();
  });
});
