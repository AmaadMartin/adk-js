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
} from '../../src/a2a/a2a_remote_agent_config.js';
import {buildRemoteAuthConfig} from '../../src/a2a/a2a_remote_agent_interceptors.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../src/auth/auth_credential.js';
import {AuthScheme} from '../../src/auth/auth_schemes.js';
import {Event as AdkEvent} from '../../src/events/event.js';
import {
  A2AChunk,
  FakeTransport,
  fakeClient,
  invocationContext,
  peerAgentCard,
  recordingCardFetch,
} from './test_helpers.js';

const CARD_URL = 'https://peer.example.com/.well-known/agent-card.json';

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
};

const API_KEY: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'key-1',
};

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

describe('buildRemoteAuthConfig', () => {
  it('derives a different credential key per remote', () => {
    const first = buildRemoteAuthConfig({
      authScheme: API_KEY_SCHEME,
      authCredential: API_KEY,
      agentCard: 'https://one.example.com/card.json',
    });
    const second = buildRemoteAuthConfig({
      authScheme: API_KEY_SCHEME,
      authCredential: API_KEY,
      agentCard: 'https://two.example.com/card.json',
    });
    expect(first.credentialKey).not.toBe(second.credentialKey);
  });

  it('derives a stable credential key for one remote', () => {
    const options = {
      authScheme: API_KEY_SCHEME,
      authCredential: API_KEY,
      agentCard: 'https://one.example.com/card.json',
    };
    expect(buildRemoteAuthConfig(options).credentialKey).toBe(
      buildRemoteAuthConfig(options).credentialKey,
    );
  });

  it('separates two schemes pointed at the same remote', () => {
    const first = buildRemoteAuthConfig({
      authScheme: API_KEY_SCHEME,
      agentCard: 'https://one.example.com/card.json',
    });
    const second = buildRemoteAuthConfig({
      authScheme: {type: 'http', scheme: 'bearer'},
      agentCard: 'https://one.example.com/card.json',
    });
    expect(first.credentialKey).not.toBe(second.credentialKey);
  });

  it('identifies a card object by its URL', () => {
    const byCard = buildRemoteAuthConfig({
      authScheme: API_KEY_SCHEME,
      agentCard: peerAgentCard({url: 'https://one.example.com/a2a'}),
    });
    const byUrl = buildRemoteAuthConfig({
      authScheme: API_KEY_SCHEME,
      agentCard: 'https://one.example.com/a2a',
    });
    expect(byCard.credentialKey).toBe(byUrl.credentialKey);
  });

  it('falls back to the card name when the card has no URL', () => {
    const named = buildRemoteAuthConfig({
      authScheme: API_KEY_SCHEME,
      agentCard: peerAgentCard({url: '', name: 'only-a-name'}),
    });
    const nameless = buildRemoteAuthConfig({
      authScheme: API_KEY_SCHEME,
      agentCard: peerAgentCard({url: '', name: ''}),
    });
    expect(named.credentialKey).not.toBe(nameless.credentialKey);
  });

  it('keeps an explicit credential key untouched', () => {
    expect(
      buildRemoteAuthConfig({
        authScheme: API_KEY_SCHEME,
        credentialKey: 'my-key',
      }).credentialKey,
    ).toBe('my-key');
  });

  it('keeps a credential key the credential names', () => {
    const credential: AuthCredential & {credentialKey: string} = {
      ...API_KEY,
      credentialKey: 'from-credential',
    };
    expect(
      buildRemoteAuthConfig({
        authScheme: API_KEY_SCHEME,
        authCredential: credential,
      }).credentialKey,
    ).toBe('from-credential');
  });

  it('keeps a credential key the scheme names', () => {
    const scheme: AuthScheme & {credentialKey: string} = {
      ...API_KEY_SCHEME,
      credentialKey: 'from-scheme',
    };
    expect(buildRemoteAuthConfig({authScheme: scheme}).credentialKey).toBe(
      'from-scheme',
    );
  });

  it('ignores an empty credential key on the scheme', () => {
    const scheme: AuthScheme & {credentialKey: string} = {
      ...API_KEY_SCHEME,
      credentialKey: '',
    };
    expect(buildRemoteAuthConfig({authScheme: scheme}).credentialKey).toMatch(
      /^adk_a2a_/,
    );
  });
});

describe('RemoteA2AAgent credential resolution', () => {
  it('sends the credential on the card fetch and on the send', async () => {
    const transport = new FakeTransport([REPLY]);
    const {fetchImpl, headers} = recordingCardFetch();
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      client: fakeClient(transport),
      fetchImpl,
      authScheme: API_KEY_SCHEME,
      authCredential: API_KEY,
    });

    await collect(agent.runAsync(invocationContext({agent})));

    expect(headers).toHaveLength(1);
    expect(headers[0]['x-api-key']).toBe('key-1');
    expect(transport.sends[0].options?.serviceParameters).toMatchObject({
      'X-API-Key': 'key-1',
    });
  });

  it('sends no auth header when no scheme is configured', async () => {
    const transport = new FakeTransport([REPLY]);
    const {fetchImpl, headers} = recordingCardFetch();
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      client: fakeClient(transport),
      fetchImpl,
      // Ignored: an authCredential without an authScheme configures no auth.
      authCredential: API_KEY,
    });

    await collect(agent.runAsync(invocationContext({agent})));

    expect(headers[0]['x-api-key']).toBeUndefined();
    expect(transport.sends[0].options?.serviceParameters).toBeUndefined();
  });

  it('keeps the credential out of the events and the request', async () => {
    const transport = new FakeTransport([REPLY]);
    const {fetchImpl} = recordingCardFetch();
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      client: fakeClient(transport),
      fetchImpl,
      authScheme: API_KEY_SCHEME,
      authCredential: API_KEY,
    });
    const ctx = invocationContext({agent});

    const events = await collect(agent.runAsync(ctx));

    expect(Object.keys(ctx.session.state)).toEqual([
      expect.stringMatching(/^temp:adk_a2a_/),
    ]);
    expect(JSON.stringify(events)).not.toContain('key-1');
    const message = transport.sends[0].params.message as Message;
    expect(JSON.stringify(message)).not.toContain('key-1');
  });

  it('appends the auth interceptor after the caller own interceptors', async () => {
    const transport = new FakeTransport([REPLY]);
    const {fetchImpl, headers} = recordingCardFetch();
    const cardInterceptors: A2ACardRequestInterceptor[] = [
      {beforeRequest: async () => ({headers: {'X-API-Key': 'caller-wins?'}})},
    ];
    const requestInterceptors: A2ARequestInterceptor[] = [
      {
        beforeRequest: async (_ctx, request, params) => [
          request,
          {...params, serviceParameters: {'X-API-Key': 'caller-wins?'}},
        ],
      },
    ];
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      client: fakeClient(transport),
      fetchImpl,
      cardRequestInterceptors: cardInterceptors,
      requestInterceptors,
      authScheme: API_KEY_SCHEME,
      authCredential: API_KEY,
    });

    await collect(agent.runAsync(invocationContext({agent})));

    expect(headers[0]['x-api-key']).toBe('key-1');
    expect(transport.sends[0].options?.serviceParameters).toMatchObject({
      'X-API-Key': 'key-1',
    });
    expect(cardInterceptors).toHaveLength(1);
    expect(requestInterceptors).toHaveLength(1);
  });

  it('asks the client for a credential it cannot resolve', async () => {
    const transport = new FakeTransport([REPLY]);
    let afterAgentRan = false;
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      authScheme: API_KEY_SCHEME,
      afterAgentCallback: () => {
        afterAgentRan = true;
        return undefined;
      },
    });

    const events = await collect(agent.runAsync(invocationContext({agent})));

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('peer_agent');
    const call = events[0].content?.parts?.[0].functionCall;
    expect(call?.name).toBe('adk_request_credential');
    expect(call?.args?.['function_call_id']).toBe(
      '_adk_toolset_auth_peer_agent',
    );
    expect(events[0].longRunningToolIds).toContain(call?.id);
    // `endInvocation` is set, so the run stops before the after-agent callback.
    expect(afterAgentRan).toBe(false);
    expect(transport.sends).toHaveLength(0);
  });

  it('does not treat a credential yielding no headers as resolved', async () => {
    const transport = new FakeTransport([REPLY]);
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      // What a failed exchange returns: a bearer credential with no token.
      authScheme: {type: 'http', scheme: 'bearer'},
      authCredential: {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {}},
      },
    });
    const ctx = invocationContext({agent});

    const events = await collect(agent.runAsync(ctx));

    expect(events[0].content?.parts?.[0].functionCall?.name).toBe(
      'adk_request_credential',
    );
    expect(ctx.session.state).toEqual({});
  });

  it('reuses a credential already in invocation state', async () => {
    const transport = new FakeTransport([REPLY]);
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      authScheme: API_KEY_SCHEME,
      credentialKey: 'fixed-key',
    });
    const ctx = invocationContext({
      agent,
      state: {'temp:fixed-key': API_KEY},
    });

    await collect(agent.runAsync(ctx));

    expect(transport.sends[0].options?.serviceParameters).toMatchObject({
      'X-API-Key': 'key-1',
    });
  });

  it('reports an auth failure without ever fetching the card', async () => {
    const transport = new FakeTransport([REPLY]);
    const {fetchImpl, headers} = recordingCardFetch();
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      client: fakeClient(transport),
      fetchImpl,
      // An oauth2 scheme with no credential makes generateAuthRequest throw.
      authScheme: {type: 'oauth2', flows: {}},
    });

    const events = await collect(agent.runAsync(invocationContext({agent})));

    expect(events).toHaveLength(1);
    expect(events[0].errorMessage).toMatch(
      /^Failed to authenticate remote A2A agent: /,
    );
    expect(headers).toHaveLength(0);
    expect(transport.sends).toHaveLength(0);
  });
});
