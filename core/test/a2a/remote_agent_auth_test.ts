/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard, Message} from '@a2a-js/sdk';
import {Client, ClientFactory} from '@a2a-js/sdk/client';
import {
  A2ACardRequestInterceptor,
  Event as AdkEvent,
  AuthConfig,
  AuthCredentialTypes,
  AuthScheme,
  createEvent,
  createSession,
  credentialRequestId,
  InvocationContext,
  PluginManager,
  RemoteA2AAgent,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  Session,
  TOOLSET_AUTH_CREDENTIAL_ID_PREFIX,
} from '@google/adk';
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

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-Api-Key',
};

const OAUTH2_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: 'https://auth.example.com/token',
      scopes: {},
    },
  },
};

interface Harness {
  cardRequests: Array<{url: string; headers: Headers}>;
  sendOptions: Array<Record<string, string> | undefined>;
  client: Client;
  clientFactory: ClientFactory;
  fetchImpl: typeof fetch;
}

function createHarness(card: AgentCard = CARD): Harness {
  const cardRequests: Array<{url: string; headers: Headers}> = [];
  const sendOptions: Array<Record<string, string> | undefined> = [];
  const client = {
    sendMessageStream: vi.fn((_params, options) => {
      sendOptions.push(options?.serviceParameters);
      return (async function* () {})();
    }),
    sendMessage: vi.fn(),
  } as unknown as Client;
  const clientFactory = {
    createFromAgentCard: vi.fn().mockResolvedValue(client),
  } as unknown as ClientFactory;
  const fetchImpl: typeof fetch = async (input, init) => {
    cardRequests.push({
      url: String(input),
      headers: new Headers(init?.headers),
    });
    return new Response(JSON.stringify(card), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  };
  return {cardRequests, sendOptions, client, clientFactory, fetchImpl};
}

function createContext(overrides: Partial<Session> = {}): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    pluginManager: new PluginManager([]),
    session: createSession({
      id: 's-1',
      userId: 'u-1',
      appName: 'app-1',
      events: [
        createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'hello'}]},
        }),
      ],
      ...overrides,
    }),
  });
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

/** The credential key inside the AuthConfig the request event carries. */
function credentialKeyOf(event: AdkEvent): string {
  const authConfig =
    event.content?.parts?.[0].functionCall?.args?.['authConfig'];
  if (!isAuthConfig(authConfig)) {
    return expect.fail('the event carries no AuthConfig');
  }
  return authConfig.credentialKey;
}

function isAuthConfig(value: unknown): value is AuthConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as {credentialKey?: unknown}).credentialKey === 'string'
  );
}

describe('RemoteA2AAgent auth', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('sends no credential header when no scheme is configured', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
    });

    await collect(agent, createContext());

    expect(harness.cardRequests).toHaveLength(1);
    expect(harness.cardRequests[0].headers.get('x-api-key')).toBeNull();
    expect(harness.sendOptions).toEqual([undefined]);
  });

  it('sends the api key on the card request and the message send', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: API_KEY_SCHEME,
      authCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret-key',
      },
    });

    await collect(agent, createContext());

    expect(harness.cardRequests[0].headers.get('x-api-key')).toBe('secret-key');
    expect(harness.sendOptions).toEqual([{'X-Api-Key': 'secret-key'}]);
  });

  it('re-fetches the card per invocation so it never leaks across sessions', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: API_KEY_SCHEME,
      authCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret-key',
      },
    });

    await collect(agent, createContext({id: 'session-a'}));
    await collect(agent, createContext({id: 'session-b'}));

    expect(harness.cardRequests).toHaveLength(2);
  });

  it('caches the card when nothing is per-invocation', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
    });

    await collect(agent, createContext());
    await collect(agent, createContext());

    expect(harness.cardRequests).toHaveLength(1);
  });

  it('lets the credential win a header conflict with an interceptor', async () => {
    const interceptor: A2ACardRequestInterceptor = {
      beforeRequest: async () => ({
        headers: {'X-Api-Key': 'interceptor-key', 'X-Trace': '1'},
      }),
    };
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      cardRequestInterceptors: [interceptor],
      authScheme: API_KEY_SCHEME,
      authCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret-key',
      },
    });

    await collect(agent, createContext());

    expect(harness.cardRequests[0].headers.get('x-api-key')).toBe('secret-key');
    expect(harness.cardRequests[0].headers.get('x-trace')).toBe('1');
  });

  it('reads a credential the client already supplied for this session', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: API_KEY_SCHEME,
      credentialKey: 'my_key',
    });
    const ctx = createContext();
    ctx.session.state['temp:my_key'] = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'collected-key',
    };

    await collect(agent, createContext(ctx.session));

    expect(harness.cardRequests[0].headers.get('x-api-key')).toBe(
      'collected-key',
    );
  });

  it('asks the client for a credential instead of calling the peer', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: API_KEY_SCHEME,
    });

    const events = await collect(agent, createContext());

    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('peer_agent');
    const call = events[0].content?.parts?.[0].functionCall;
    expect(call?.name).toBe(REQUEST_CREDENTIAL_FUNCTION_CALL_NAME);
    expect(call?.id).toBe(`${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}peer_agent`);
    // The client must be able to pause on it, so it is a long-running call.
    expect(events[0].longRunningToolIds).toEqual([
      `${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}peer_agent`,
    ]);
    expect(harness.cardRequests).toHaveLength(0);
    expect(harness.client.sendMessageStream).not.toHaveBeenCalled();
  });

  it('ends the invocation when it asks for a credential', async () => {
    let afterAgentRan = false;
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: API_KEY_SCHEME,
      afterAgentCallback: () => {
        afterAgentRan = true;
        return undefined;
      },
    });

    await collect(agent, createContext());

    expect(afterAgentRan).toBe(false);
  });

  it('resolves the credential the client sent on the previous turn', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: API_KEY_SCHEME,
    });

    const firstTurn = createContext();
    const [request] = await collect(agent, firstTurn);
    expect(harness.cardRequests).toHaveLength(0);

    // What the client sends back: the AuthConfig from the request, with the
    // credential filled in.
    const requestId = credentialRequestId('peer_agent');
    const answered = {
      ...(request.content?.parts?.[0].functionCall?.args?.[
        'authConfig'
      ] as object),
      exchangedAuthCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'collected-key',
      },
    };
    const secondTurn = createContext({
      events: [
        ...firstTurn.session.events,
        request,
        createEvent({
          author: 'user',
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: requestId,
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  response: answered,
                },
              },
            ],
          },
        }),
      ],
    });

    const events = await collect(agent, secondTurn);

    expect(
      events.some(
        (event) =>
          event.content?.parts?.[0].functionCall?.name ===
          REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
      ),
    ).toBe(false);
    expect(harness.cardRequests[0].headers.get('x-api-key')).toBe(
      'collected-key',
    );
    expect(harness.sendOptions).toEqual([{'X-Api-Key': 'collected-key'}]);
  });

  it('does not read a credential answered for another request', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: API_KEY_SCHEME,
    });
    const ctx = createContext({
      events: [
        createEvent({
          author: 'user',
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: credentialRequestId('another_agent'),
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  response: {
                    authScheme: API_KEY_SCHEME,
                    credentialKey: 'adk_a2a_another_agent',
                    exchangedAuthCredential: {
                      authType: AuthCredentialTypes.API_KEY,
                      apiKey: 'not-mine',
                    },
                  },
                },
              },
            ],
          },
        }),
      ],
    });

    const events = await collect(agent, ctx);

    expect(events[0].content?.parts?.[0].functionCall?.name).toBe(
      REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
    );
    expect(harness.cardRequests).toHaveLength(0);
  });

  it('rejects a credential whose exchange produced no token', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: API_KEY_SCHEME,
      credentialKey: 'my_key',
    });
    const ctx = createContext();
    ctx.session.state['temp:my_key'] = {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'id'},
    };

    const events = await collect(agent, ctx);

    expect(events[0].content?.parts?.[0].functionCall?.name).toBe(
      REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
    );
  });

  it('reports an auth failure as an error event', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      // An oauth2 scheme with no credential cannot start an exchange, so
      // generating the request throws.
      authScheme: OAUTH2_SCHEME,
    });

    const events = await collect(agent, createContext());

    expect(events).toHaveLength(1);
    expect(events[0].errorMessage).toContain(
      'Failed to authenticate remote A2A agent',
    );
    expect(harness.client.sendMessageStream).not.toHaveBeenCalled();
  });

  it('derives a distinct credential key per agent', async () => {
    const first = new RemoteA2AAgent({
      name: 'agent_one',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: API_KEY_SCHEME,
    });
    const second = new RemoteA2AAgent({
      name: 'agent_two',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: API_KEY_SCHEME,
    });

    const firstEvents = await collect(first, createContext());
    const secondEvents = await collect(second, createContext());

    expect(credentialKeyOf(firstEvents[0])).toBe('adk_a2a_agent_one');
    expect(credentialKeyOf(secondEvents[0])).toBe('adk_a2a_agent_two');
  });

  it('uses the credential key the caller supplied', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: API_KEY_SCHEME,
      credentialKey: 'shared_key',
    });

    const events = await collect(agent, createContext());

    expect(credentialKeyOf(events[0])).toBe('shared_key');
  });

  it('never writes the credential into session state', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: API_KEY_SCHEME,
      authCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret-key',
      },
    });
    const ctx = createContext();

    await collect(agent, ctx);

    expect(JSON.stringify(ctx.session.state)).not.toContain('secret-key');
  });

  it('sends an http bearer credential', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: {type: 'http', scheme: 'bearer'},
      authCredential: {
        authType: AuthCredentialTypes.HTTP,
        http: {scheme: 'bearer', credentials: {token: 'tok'}},
      },
    });

    await collect(agent, createContext());

    expect(harness.cardRequests[0].headers.get('authorization')).toBe(
      'Bearer tok',
    );
    expect(harness.sendOptions).toEqual([{Authorization: 'Bearer tok'}]);
  });

  it('does not mutate the caller interceptor list', async () => {
    const interceptors: A2ACardRequestInterceptor[] = [];
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      cardRequestInterceptors: interceptors,
      authScheme: API_KEY_SCHEME,
      authCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret-key',
      },
    });

    await collect(agent, createContext());

    expect(interceptors).toHaveLength(0);
  });

  it('carries the credential on the message the peer receives', async () => {
    const agent = new RemoteA2AAgent({
      name: 'peer_agent',
      agentCard: CARD_URL,
      clientFactory: harness.clientFactory,
      fetchImpl: harness.fetchImpl,
      authScheme: API_KEY_SCHEME,
      authCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret-key',
      },
    });

    await collect(agent, createContext());

    const [params] = vi.mocked(harness.client.sendMessageStream).mock.calls[0];
    expect((params.message as Message).parts).toHaveLength(1);
  });
});
