/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message} from '@a2a-js/sdk';
import {describe, expect, it} from 'vitest';
import {RemoteA2AAgent} from '../../src/a2a/a2a_remote_agent.js';
import {
  A2APartToGenAIPartConverter,
  GenAIPartToA2APartConverter,
} from '../../src/a2a/a2a_remote_agent_config.js';
import {AdkMetadataKeys} from '../../src/a2a/metadata_converter_utils.js';
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

describe('RemoteA2AAgent part converters', () => {
  it('uses a custom genai converter on the outbound path', async () => {
    const transport = new FakeTransport([REPLY]);
    const genaiPartConverter: GenAIPartToA2APartConverter = () => ({
      kind: 'text',
      text: 'converted-out',
    });
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      genaiPartConverter,
    });

    await collect(agent.runAsync(invocationContext({agent})));

    const message = transport.sends[0].params.message as Message;
    expect(message.parts).toEqual([{kind: 'text', text: 'converted-out'}]);
  });

  it('expands a genai converter that returns several parts', async () => {
    const transport = new FakeTransport([REPLY]);
    const genaiPartConverter: GenAIPartToA2APartConverter = () => [
      {kind: 'text', text: 'one'},
      {kind: 'text', text: 'two'},
    ];
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      genaiPartConverter,
    });

    await collect(agent.runAsync(invocationContext({agent})));

    const message = transport.sends[0].params.message as Message;
    expect(message.parts).toHaveLength(2);
  });

  it('drops an outbound part the converter refuses', async () => {
    const transport = new FakeTransport([REPLY]);
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      genaiPartConverter: () => undefined,
    });

    const events = await collect(agent.runAsync(invocationContext({agent})));

    // Nothing survives conversion, so the peer is never called.
    expect(transport.sends).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0].content).toEqual({});
  });

  it('uses a custom a2a converter on the inbound path', async () => {
    const transport = new FakeTransport([REPLY]);
    const a2aPartConverter: A2APartToGenAIPartConverter = () => ({
      text: 'converted-in',
    });
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      a2aPartConverter,
    });

    const events = await collect(agent.runAsync(invocationContext({agent})));

    expect(events[0].content?.parts).toEqual([{text: 'converted-in'}]);
  });

  it('drops an inbound part the converter refuses', async () => {
    const transport = new FakeTransport([REPLY]);
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      a2aPartConverter: () => undefined,
    });

    const events = await collect(agent.runAsync(invocationContext({agent})));

    expect(events[0].content).toBeUndefined();
  });
});

describe('RemoteA2AAgent empty request', () => {
  it('sends nothing when a credential-only resume leaves no parts', async () => {
    const transport = new FakeTransport([REPLY]);
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
    });
    const credentialRequest = createEvent({
      author: 'root_agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc1',
              name: 'adk_request_credential',
              args: {functionCallId: 'toolFc1', authConfig: {}},
            },
          },
        ],
      },
    });
    const credentialResponse = createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc1',
              name: 'adk_request_credential',
              response: {
                authScheme: {type: 'oauth2'},
                credentialKey: 'k',
                exchangedAuthCredential: {oauth2: {accessToken: 'SECRET'}},
              },
            },
          },
        ],
      },
    });

    const events = await collect(
      agent.runAsync(
        invocationContext({
          agent,
          events: [credentialRequest, credentialResponse],
        }),
      ),
    );

    expect(transport.sends).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0].content).toEqual({});
  });
});

describe('RemoteA2AAgent request metadata provider', () => {
  it('sends the metadata an interceptor set on the parameters', async () => {
    const transport = new FakeTransport([REPLY]);
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      requestInterceptors: [
        {
          beforeRequest: async (_ctx, request, params) => [
            request,
            {...params, requestMetadata: {from: 'interceptor'}},
          ],
        },
      ],
    });

    await collect(agent.runAsync(invocationContext({agent})));

    expect(transport.sends[0].params.metadata).toEqual({from: 'interceptor'});
  });

  it('lets the provider override what an interceptor set', async () => {
    const transport = new FakeTransport([REPLY]);
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      requestInterceptors: [
        {
          beforeRequest: async (_ctx, request, params) => [
            request,
            {...params, requestMetadata: {from: 'interceptor'}},
          ],
        },
      ],
      a2aRequestMetaProvider: () => ({from: 'provider'}),
    });

    await collect(agent.runAsync(invocationContext({agent})));

    expect(transport.sends[0].params.metadata).toEqual({from: 'provider'});
  });

  it('supplies the outgoing request metadata', async () => {
    const transport = new FakeTransport([REPLY]);
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      metadata: {from: 'config'},
      a2aRequestMetaProvider: (_ctx, message) => ({
        messageId: message.messageId,
      }),
    });

    await collect(agent.runAsync(invocationContext({agent})));

    const message = transport.sends[0].params.message as Message;
    expect(transport.sends[0].params.metadata).toEqual({
      messageId: message.messageId,
    });
  });
});

describe('RemoteA2AAgent timeout and close', () => {
  it('reports a transport failure with the error metadata', async () => {
    const failure = Object.assign(new Error('boom'), {status: 503});
    const transport = new FakeTransport([], failure);
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
    });

    const events = await collect(agent.runAsync(invocationContext({agent})));

    expect(events).toHaveLength(1);
    expect(events[0].errorMessage).toMatch(/^A2A request failed: /);
    expect(events[0].customMetadata?.[AdkMetadataKeys.ERROR]).toMatch(
      /^A2A request failed: /,
    );
    expect(events[0].customMetadata?.[AdkMetadataKeys.STATUS_CODE]).toBe('503');
  });

  it('omits the status code when the failure exposes none', async () => {
    const transport = new FakeTransport([], new Error('boom'));
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
    });

    const events = await collect(agent.runAsync(invocationContext({agent})));

    expect(
      events[0].customMetadata?.[AdkMetadataKeys.STATUS_CODE],
    ).toBeUndefined();
  });

  it('aborts a hung send once the timeout elapses', async () => {
    const transport = FakeTransport.hanging();
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      timeoutMs: 10,
    });

    const events = await collect(agent.runAsync(invocationContext({agent})));

    expect(events[0].errorMessage).toMatch(/^A2A request failed: /);
  });

  it('aborts an in-flight send when the agent is closed', async () => {
    const transport = FakeTransport.hanging();
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
    });

    const run = collect(agent.runAsync(invocationContext({agent})));
    await new Promise((resolve) => setTimeout(resolve, 5));
    agent.close();

    const events = await run;
    expect(events[0].errorMessage).toMatch(/^A2A request failed: /);
  });

  it('drops the cached card on close and keeps a caller-supplied client', async () => {
    const transport = new FakeTransport([REPLY]);
    const {fetchImpl, headers} = recordingCardFetch();
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      client: fakeClient(transport),
      fetchImpl,
    });

    await collect(agent.runAsync(invocationContext({agent})));
    agent.close();
    agent.close();
    const events = await collect(agent.runAsync(invocationContext({agent})));

    // The card cache was dropped, so the second run resolves it again; the
    // caller's client is untouched and answers both turns.
    expect(headers).toHaveLength(2);
    expect(transport.sends).toHaveLength(2);
    expect(events).toHaveLength(1);
  });

  it('caches the card across runs when it is not closed', async () => {
    const transport = new FakeTransport([REPLY]);
    const {fetchImpl, headers} = recordingCardFetch();
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      client: fakeClient(transport),
      fetchImpl,
    });

    await collect(agent.runAsync(invocationContext({agent})));
    await collect(agent.runAsync(invocationContext({agent})));

    expect(headers).toHaveLength(1);
  });
});
