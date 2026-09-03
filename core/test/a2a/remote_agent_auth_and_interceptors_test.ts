/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part as A2APart,
  AgentCard,
  HTTP_EXTENSION_HEADER,
  Message,
} from '@a2a-js/sdk';
import {
  Client,
  ClientFactory,
  DefaultAgentCardResolver,
  RequestOptions,
} from '@a2a-js/sdk/client';
import {
  A2ACardRequestInterceptor,
  A2ARequestInterceptor,
  Event as AdkEvent,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  createEvent,
  NEW_A2A_ADK_INTEGRATION_EXTENSION,
  RemoteA2AAgent,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  Session,
} from '@google/adk';
import {Part as GenAIPart} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';

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

const CARD_URL = 'https://remote.example.com/.well-known/agent-card.json';

const CARD: AgentCard = {
  name: 'Remote',
  description: 'remote agent',
  protocolVersion: '1.0',
  defaultInputModes: [],
  defaultOutputModes: [],
  capabilities: {streaming: true},
  skills: [],
  url: 'https://remote.example.com/a2a',
  version: '1.0',
};

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-Api-Key',
  in: 'header',
};

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'secret-key',
};

describe('RemoteA2AAgent authentication and interceptors', () => {
  let mockClient: Client;
  let mockClientFactory: ClientFactory;
  let mockResolver: DefaultAgentCardResolver;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      sendMessageStream: vi.fn().mockReturnValue((async function* () {})()),
      sendMessage: vi.fn(),
    } as unknown as Client;

    mockClientFactory = {
      createFromAgentCard: vi.fn().mockResolvedValue(mockClient),
    } as unknown as ClientFactory;

    mockResolver = {
      resolve: vi.fn().mockResolvedValue(CARD),
    } as unknown as DefaultAgentCardResolver;

    vi.mocked(ClientFactory).mockImplementation(() => mockClientFactory);
    vi.mocked(DefaultAgentCardResolver).mockImplementation(() => mockResolver);
  });

  const createContext = (): InvocationContext =>
    new InvocationContext({
      invocationId: 'inv-1',
      session: {
        id: 'session-1',
        appName: 'app',
        userId: 'user',
        state: {},
        events: [
          createEvent({
            author: 'user',
            content: {role: 'user', parts: [{text: 'hello'}]},
          }),
        ],
        lastUpdateTime: Date.now(),
      } as Session,
      pluginManager: new PluginManager(),
    });

  const run = async (
    agent: RemoteA2AAgent,
    context = createContext(),
  ): Promise<{events: AdkEvent[]; context: InvocationContext}> => {
    const events: AdkEvent[] = [];
    for await (const event of agent.runAsync(context)) {
      events.push(event);
    }
    return {events, context};
  };

  /** The RequestOptions the client was called with. */
  const sentOptions = (): RequestOptions | undefined =>
    vi.mocked(mockClient.sendMessageStream).mock.calls[0]?.[1];

  describe('authentication', () => {
    it('configures nothing without an auth scheme', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        authCredential: API_KEY_CREDENTIAL,
        clientFactory: mockClientFactory,
      });

      await run(agent);

      expect(sentOptions()?.serviceParameters).toBeUndefined();
    });

    it('sends the credential on the card fetch and on the send', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        authScheme: API_KEY_SCHEME,
        authCredential: API_KEY_CREDENTIAL,
        clientFactory: mockClientFactory,
      });

      await run(agent);

      expect(sentOptions()?.serviceParameters).toEqual({
        'X-Api-Key': 'secret-key',
      });
      expect(vi.mocked(DefaultAgentCardResolver).mock.calls).toHaveLength(1);
      expect(mockResolver.resolve).toHaveBeenCalledWith(CARD_URL);
    });

    it('caches the credential on the invocation, not the session', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        authScheme: API_KEY_SCHEME,
        authCredential: API_KEY_CREDENTIAL,
        clientFactory: mockClientFactory,
      });

      const {context} = await run(agent);

      expect(Object.values(context.credentialByKey)).toEqual([
        API_KEY_CREDENTIAL,
      ]);
      expect(JSON.stringify(context.session.state)).not.toContain('secret-key');
    });

    it('pauses for a credential it cannot resolve', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        authScheme: API_KEY_SCHEME,
        clientFactory: mockClientFactory,
      });

      const {events} = await run(agent);

      expect(events).toHaveLength(1);
      expect(events[0].content?.parts?.[0].functionCall?.name).toBe(
        REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
      );
      expect(mockClient.sendMessageStream).not.toHaveBeenCalled();
    });

    it('reports a failure to authenticate as an error event', async () => {
      const oauthScheme: AuthScheme = {
        type: 'oauth2',
        flows: {
          authorizationCode: {authorizationUrl: '', tokenUrl: '', scopes: {}},
        },
      };
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        authScheme: oauthScheme,
        authCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id', clientSecret: 'secret'},
        },
        clientFactory: mockClientFactory,
      });

      const {events} = await run(agent);

      expect(events).toHaveLength(1);
      expect(events[0].errorMessage).toContain(
        'Failed to authenticate remote A2A agent',
      );
      expect(mockClient.sendMessageStream).not.toHaveBeenCalled();
    });

    it('derives a different credential key per remote', async () => {
      const build = (url: string) =>
        new RemoteA2AAgent({
          name: 'remote_agent',
          agentCard: url,
          authScheme: API_KEY_SCHEME,
          authCredential: API_KEY_CREDENTIAL,
          clientFactory: mockClientFactory,
        });

      const first = await keyUsedBy(build('https://one.example.com/card.json'));
      const second = await keyUsedBy(
        build('https://two.example.com/card.json'),
      );

      expect(first).toBeDefined();
      expect(first).not.toBe(second);
    });

    it('derives the same credential key for the same remote', async () => {
      const build = () =>
        new RemoteA2AAgent({
          name: 'remote_agent',
          agentCard: CARD_URL,
          authScheme: API_KEY_SCHEME,
          authCredential: API_KEY_CREDENTIAL,
          clientFactory: mockClientFactory,
        });

      expect(await keyUsedBy(build())).toBe(await keyUsedBy(build()));
    });

    it('uses the credential key the caller set', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        authScheme: API_KEY_SCHEME,
        authCredential: API_KEY_CREDENTIAL,
        credentialKey: 'my-key',
        clientFactory: mockClientFactory,
      });

      expect(await keyUsedBy(agent)).toBe('my-key');
    });

    /** The credential key an agent caches its resolved credential under. */
    const keyUsedBy = async (
      agent: RemoteA2AAgent,
    ): Promise<string | undefined> => {
      const {context} = await run(agent);
      return Object.keys(context.credentialByKey)[0];
    };
  });

  describe('interceptors', () => {
    it('sends the headers a card interceptor asks for', async () => {
      const fetches: Array<Record<string, string> | undefined> = [];
      vi.mocked(DefaultAgentCardResolver).mockImplementation((options) => {
        fetches.push(options?.fetchImpl ? {called: 'yes'} : undefined);
        return mockResolver;
      });
      const interceptor: A2ACardRequestInterceptor = {
        async beforeRequest() {
          return {headers: {'X-Card': 'yes'}};
        },
      };
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        cardRequestInterceptors: [interceptor],
        clientFactory: mockClientFactory,
      });

      await run(agent);

      expect(fetches).toEqual([{called: 'yes'}]);
    });

    it('resolves the card per invocation when a card interceptor is set', async () => {
      const interceptor: A2ACardRequestInterceptor = {
        async beforeRequest() {
          return {headers: {'X-Card': 'yes'}};
        },
      };
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        cardRequestInterceptors: [interceptor],
        clientFactory: mockClientFactory,
      });

      await run(agent);
      await run(agent);

      expect(mockResolver.resolve).toHaveBeenCalledTimes(2);
    });

    it('caches the card when no card interceptor is set', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        clientFactory: mockClientFactory,
      });

      await run(agent);
      await run(agent);

      expect(mockResolver.resolve).toHaveBeenCalledTimes(1);
    });

    it('sends the headers a request interceptor asks for', async () => {
      const interceptor: A2ARequestInterceptor = {
        async beforeRequest(_ctx, request, params) {
          return {request, params: {...params, headers: {'X-Send': 'yes'}}};
        },
      };
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        requestInterceptors: [interceptor],
        clientFactory: mockClientFactory,
      });

      await run(agent);

      expect(sentOptions()?.serviceParameters).toEqual({'X-Send': 'yes'});
    });

    it('sends the metadata a request interceptor asks for', async () => {
      const interceptor: A2ARequestInterceptor = {
        async beforeRequest(_ctx, request, params) {
          return {request, params: {...params, requestMetadata: {tag: 'v'}}};
        },
      };
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        requestInterceptors: [interceptor],
        clientFactory: mockClientFactory,
      });

      await run(agent);

      const params = vi.mocked(mockClient.sendMessageStream).mock.calls[0][0];
      expect(params.metadata).toEqual({tag: 'v'});
    });

    it('yields the event a request interceptor aborts with', async () => {
      const abort = createEvent({author: 'remote_agent', errorMessage: 'no'});
      const interceptor: A2ARequestInterceptor = {
        async beforeRequest(_ctx, _request, params) {
          return {request: abort, params};
        },
      };
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        requestInterceptors: [interceptor],
        clientFactory: mockClientFactory,
      });

      const {events} = await run(agent);

      expect(events).toEqual([abort]);
      expect(mockClient.sendMessageStream).not.toHaveBeenCalled();
    });

    it('drops an event an after-request interceptor rejects', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield {
            kind: 'message',
            messageId: 'm-1',
            role: 'agent',
            parts: [{kind: 'text', text: 'response'}],
          } as Message;
        })(),
      );
      const interceptor: A2ARequestInterceptor = {
        async afterRequest() {
          return undefined;
        },
      };
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        requestInterceptors: [interceptor],
        clientFactory: mockClientFactory,
      });

      const {events} = await run(agent);

      expect(events).toEqual([]);
    });

    it('does not put its own interceptors on a shared config', () => {
      const requestInterceptors: A2ARequestInterceptor[] = [];
      const cardRequestInterceptors: A2ACardRequestInterceptor[] = [];
      const config = {
        name: 'remote_agent',
        agentCard: CARD_URL,
        authScheme: API_KEY_SCHEME,
        authCredential: API_KEY_CREDENTIAL,
        requestInterceptors,
        cardRequestInterceptors,
        clientFactory: mockClientFactory,
      };

      new RemoteA2AAgent({...config, name: 'first'});
      new RemoteA2AAgent({...config, name: 'second'});

      expect(requestInterceptors).toEqual([]);
      expect(cardRequestInterceptors).toEqual([]);
    });

    it('declares the new integration extension when useLegacy is false', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        useLegacy: false,
        clientFactory: mockClientFactory,
      });

      await run(agent);

      expect(sentOptions()?.serviceParameters).toEqual({
        [HTTP_EXTENSION_HEADER]: NEW_A2A_ADK_INTEGRATION_EXTENSION,
      });
    });

    it('declares no extension by default', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        clientFactory: mockClientFactory,
      });

      await run(agent);

      expect(sentOptions()?.serviceParameters).toBeUndefined();
    });
  });

  describe('timeout and converters', () => {
    it('bounds the send with an abort signal', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        timeout: 1000,
        clientFactory: mockClientFactory,
      });

      await run(agent);

      expect(sentOptions()?.signal).toBeInstanceOf(AbortSignal);
      expect(sentOptions()?.signal?.aborted).toBe(false);
    });

    it('uses a caller-supplied outgoing part converter', async () => {
      const genaiPartConverter = vi.fn(
        (_part: GenAIPart): A2APart => ({kind: 'text', text: 'rewritten'}),
      );
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        genaiPartConverter,
        clientFactory: mockClientFactory,
      });

      await run(agent);

      const params = vi.mocked(mockClient.sendMessageStream).mock.calls[0][0];
      expect(params.message.parts).toEqual([{kind: 'text', text: 'rewritten'}]);
    });

    it('uses a caller-supplied incoming part converter', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield {
            kind: 'message',
            messageId: 'm-1',
            role: 'agent',
            parts: [{kind: 'text', text: 'response'}],
          } as Message;
        })(),
      );
      const a2aPartConverter = vi.fn(
        (_part: A2APart): GenAIPart => ({text: 'converted'}),
      );
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD_URL,
        a2aPartConverter,
        clientFactory: mockClientFactory,
      });

      const {events} = await run(agent);

      expect(events[0].content?.parts).toEqual([{text: 'converted'}]);
    });
  });
});
