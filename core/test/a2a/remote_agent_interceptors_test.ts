/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message} from '@a2a-js/sdk';
import {describe, expect, it} from 'vitest';
import {RemoteA2AAgent} from '../../src/a2a/a2a_remote_agent.js';
import {
  A2ACardRequestInterceptor,
  A2ARequestInterceptor,
  NEW_A2A_ADK_INTEGRATION_EXTENSION,
} from '../../src/a2a/a2a_remote_agent_config.js';
import {Event as AdkEvent, createEvent} from '../../src/events/event.js';
import {
  A2AChunk,
  FakeTransport,
  fakeClient,
  invocationContext,
  peerAgentCard,
  recordingCardFetch,
} from './test_helpers.js';

const CARD_URL = 'https://peer.example.com/.well-known/agent-card.json';

const REPLY: A2AChunk = {
  kind: 'message',
  messageId: 'm-1',
  role: 'agent',
  parts: [{kind: 'text', text: 'hi'}],
};

async function collect(
  events: AsyncGenerator<AdkEvent, void, void>,
): Promise<AdkEvent[]> {
  const collected: AdkEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

/** Runs one turn against a scripted peer and returns the events and transport. */
async function runWith(
  config: Partial<ConstructorParameters<typeof RemoteA2AAgent>[0]> = {},
  chunks: A2AChunk[] = [REPLY],
): Promise<{events: AdkEvent[]; transport: FakeTransport}> {
  const transport = new FakeTransport(chunks);
  const agent = new RemoteA2AAgent({
    name: 'peer_agent',
    agentCard: peerAgentCard(),
    client: fakeClient(transport),
    ...config,
  });
  const events = await collect(agent.runAsync(invocationContext({agent})));
  return {events, transport};
}

describe('RemoteA2AAgent request interceptors', () => {
  it('sends the request unchanged when none is configured', async () => {
    const {events, transport} = await runWith();
    expect(transport.sends).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('treats an empty interceptor list as a no-op', async () => {
    const {transport} = await runWith({requestInterceptors: []});
    expect(transport.sends).toHaveLength(1);
  });

  it('runs beforeRequest in order and threads the parameters through', async () => {
    const order: string[] = [];
    const first: A2ARequestInterceptor = {
      beforeRequest: async (_ctx, request, params) => {
        order.push('first');
        return [request, {...params, serviceParameters: {'X-Order': 'first'}}];
      },
    };
    const second: A2ARequestInterceptor = {
      beforeRequest: async (_ctx, request, params) => {
        order.push('second');
        return [
          {...request, parts: [{kind: 'text', text: 'rewritten'}]},
          {
            ...params,
            serviceParameters: {...params.serviceParameters, 'X-Two': 'yes'},
          },
        ];
      },
    };

    const {transport} = await runWith({
      requestInterceptors: [first, {}, second],
    });

    expect(order).toEqual(['first', 'second']);
    const message = transport.sends[0].params.message as Message;
    expect(message.parts).toEqual([{kind: 'text', text: 'rewritten'}]);
    expect(transport.sends[0].options?.serviceParameters).toEqual({
      'X-Order': 'first',
      'X-Two': 'yes',
    });
  });

  it('aborts the run when beforeRequest returns an event', async () => {
    const aborting: A2ARequestInterceptor = {
      beforeRequest: async (_ctx, _request, params) => [
        createEvent({author: 'peer_agent', errorMessage: 'blocked'}),
        params,
      ],
    };
    const never: A2ARequestInterceptor = {
      beforeRequest: async () => {
        throw new Error('later interceptors must not run');
      },
    };

    const {events, transport} = await runWith({
      requestInterceptors: [aborting, never],
    });

    expect(events).toHaveLength(1);
    expect(events[0].errorMessage).toBe('blocked');
    expect(transport.sends).toHaveLength(0);
  });

  it('runs afterRequest in reverse order', async () => {
    const order: string[] = [];
    const first: A2ARequestInterceptor = {
      afterRequest: async (_ctx, _response, event) => {
        order.push('first');
        return event;
      },
    };
    const second: A2ARequestInterceptor = {
      afterRequest: async (_ctx, _response, event) => {
        order.push('second');
        return event;
      },
    };

    await runWith({requestInterceptors: [first, {}, second]});

    expect(order).toEqual(['second', 'first']);
  });

  it('drops the event when afterRequest returns undefined', async () => {
    const dropping: A2ARequestInterceptor = {
      afterRequest: async () => undefined,
    };

    const {events} = await runWith({requestInterceptors: [dropping]});

    expect(events).toHaveLength(0);
  });

  it('emits the event afterRequest replaced it with', async () => {
    const replacing: A2ARequestInterceptor = {
      afterRequest: async (_ctx, _response, event) => ({
        ...event,
        errorMessage: 'replaced',
      }),
    };

    const {events} = await runWith({requestInterceptors: [replacing]});

    expect(events[0].errorMessage).toBe('replaced');
  });
});

describe('RemoteA2AAgent card request interceptors', () => {
  it('merges headers in list order, later winning', async () => {
    const transport = new FakeTransport([REPLY]);
    const {fetchImpl, headers} = recordingCardFetch();
    const interceptors: A2ACardRequestInterceptor[] = [
      {beforeRequest: async () => ({headers: {'X-One': 'a', 'X-Two': 'a'}})},
      {},
      {beforeRequest: async () => ({headers: {'X-Two': 'b'}})},
      {beforeRequest: async () => ({})},
    ];
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      client: fakeClient(transport),
      fetchImpl,
      cardRequestInterceptors: interceptors,
    });

    await collect(agent.runAsync(invocationContext({agent})));

    expect(headers[0]['x-one']).toBe('a');
    expect(headers[0]['x-two']).toBe('b');
  });

  it('re-fetches the card per invocation so one session never sees another', async () => {
    const transport = new FakeTransport([REPLY, REPLY]);
    const {fetchImpl, headers} = recordingCardFetch();
    let turn = 0;
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      client: fakeClient(transport),
      fetchImpl,
      cardRequestInterceptors: [
        {beforeRequest: async () => ({headers: {'X-Turn': String(++turn)}})},
      ],
    });

    await collect(agent.runAsync(invocationContext({agent})));
    await collect(agent.runAsync(invocationContext({agent})));

    expect(headers.map((h) => h['x-turn'])).toEqual(['1', '2']);
  });

  it('ignores card interceptors for a card object', async () => {
    const {fetchImpl, headers} = recordingCardFetch();
    const {transport} = await runWith({
      fetchImpl,
      cardRequestInterceptors: [
        {beforeRequest: async () => ({headers: {'X-One': 'a'}})},
      ],
    });

    expect(headers).toHaveLength(0);
    expect(transport.sends).toHaveLength(1);
  });
});

describe('RemoteA2AAgent new-integration extension', () => {
  it('declares no extension by default', async () => {
    const {transport} = await runWith();
    expect(transport.sends[0].options?.serviceParameters).toBeUndefined();
  });

  it('declares the extension when useLegacy is false', async () => {
    const {transport} = await runWith({useLegacy: false});
    const parameters = transport.sends[0].options?.serviceParameters ?? {};
    expect(Object.values(parameters)).toContain(
      NEW_A2A_ADK_INTEGRATION_EXTENSION,
    );
  });

  it('names the extension exactly as the wire format expects', () => {
    expect(NEW_A2A_ADK_INTEGRATION_EXTENSION).toBe(
      'https://google.github.io/adk-docs/a2a/a2a-extension/',
    );
  });
});
