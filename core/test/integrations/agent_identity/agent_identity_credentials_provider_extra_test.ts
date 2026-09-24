/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests written for the TypeScript port. They cover behaviour the ported
 * adk-python tests do not reach, and live apart so the ported set stays
 * legible.
 */

import {
  AuthCredentialTypes,
  Event,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  createEvent,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {RestAgentIdentityCredentialsClient} from '../../../src/integrations/agent_identity/agent_identity_credentials_client.js';
import {
  AgentIdentityCredentialsProvider,
  isConsentCompleted,
} from '../../../src/integrations/agent_identity/agent_identity_credentials_provider.js';
import {
  AUTH_PROVIDER_NAME,
  FakeCredentialsClient,
  bearerSuccess,
  createAuthScheme,
  createContext,
} from './agent_identity_fixtures.js';

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: () =>
      Promise.resolve({
        getRequestHeaders: () =>
          Promise.resolve(new Headers({authorization: 'Bearer fake-token'})),
      }),
  })),
}));

function credentialCallEvent(functionCall: Record<string, unknown>): Event {
  return createEvent({
    author: 'agent',
    content: {role: 'model', parts: [{functionCall}]},
  });
}

function credentialResponseEvent(id: string): Event {
  return createEvent({
    author: 'user',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id,
            name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
            response: {},
          },
        },
      ],
    },
  });
}

describe('the retrieve request', () => {
  it('carries the scheme scopes and continue URI', async () => {
    const client = new FakeCredentialsClient(() => bearerSuccess());
    const provider = new AgentIdentityCredentialsProvider({client});

    await provider.getAuthCredential(
      createAuthScheme({
        scopes: ['scope-a', 'scope-b'],
        continueUri: 'https://agent.example.com/oauth/continue',
      }),
      createContext(),
    );

    expect(client.authProviders).toEqual([AUTH_PROVIDER_NAME]);
    expect(client.requests[0]).toStrictEqual({
      userId: 'user',
      scopes: ['scope-a', 'scope-b'],
      continueUri: 'https://agent.example.com/oauth/continue',
    });
  });

  it('omits the scopes and continue URI the scheme does not set', async () => {
    const client = new FakeCredentialsClient(() => bearerSuccess());
    const provider = new AgentIdentityCredentialsProvider({client});

    await provider.getAuthCredential(
      createAuthScheme({scopes: undefined, continueUri: undefined}),
      createContext(),
    );

    expect(client.requests[0]).toStrictEqual({userId: 'user'});
  });
});

describe('the credential the service header selects', () => {
  it.each([
    ['Authorization: Bearer', 'the reference casing'],
    ['authorization:bearer', 'no space and lower case'],
    ['  AUTHORIZATION :  BEARER abc', 'padding and upper case'],
  ])('reads %s as a bearer token (%s)', async (header) => {
    const provider = new AgentIdentityCredentialsProvider({
      client: new FakeCredentialsClient(() => ({
        success: {header, token: 'test-token'},
      })),
    });

    const credential = await provider.getAuthCredential(
      createAuthScheme(),
      createContext(),
    );

    expect(credential.http).toEqual({
      scheme: 'Bearer',
      credentials: {token: 'test-token'},
    });
  });

  it.each([
    ['x-api-key', 'a header name with no colon'],
    ['Authorization: Basic', 'an Authorization header of another scheme'],
    ['x-token: Bearer', 'a bearer value under another header name'],
  ])('reads %s as a custom header (%s)', async (header) => {
    const provider = new AgentIdentityCredentialsProvider({
      client: new FakeCredentialsClient(() => ({
        success: {header, token: 'test-token'},
      })),
    });

    const credential = await provider.getAuthCredential(
      createAuthScheme(),
      createContext(),
    );

    expect(credential.http).toEqual({
      scheme: '',
      credentials: {},
      additionalHeaders: {
        [header]: 'test-token',
        'X-GOOG-API-KEY': 'test-token',
      },
    });
  });
});

describe('polling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops at the first success instead of running to the timeout', async () => {
    const client = new FakeCredentialsClient((callIndex) =>
      callIndex < 2 ? {pending: {}} : bearerSuccess(),
    );
    const provider = new AgentIdentityCredentialsProvider({client});
    vi.useFakeTimers();

    const pending = provider.getAuthCredential(
      createAuthScheme(),
      createContext(),
    );
    await vi.advanceTimersByTimeAsync(11000);
    const credential = await pending;

    expect(credential.http?.credentials.token).toBe('test-token');
    expect(client.requests).toHaveLength(3);
  });

  it('rejects when the user refuses consent while polling', async () => {
    const client = new FakeCredentialsClient((callIndex) =>
      callIndex === 0 ? {pending: {}} : {consentRejected: {}},
    );
    const provider = new AgentIdentityCredentialsProvider({client});
    vi.useFakeTimers();

    const pending = provider
      .getAuthCredential(createAuthScheme(), createContext())
      .catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(11000);

    expect(await pending).toEqual(
      new Error('Operation failed: User consent rejected.'),
    );
  });

  it('asks for consent when polling ends in uriConsentRequired', async () => {
    const client = new FakeCredentialsClient((callIndex) =>
      callIndex === 0
        ? {pending: {}}
        : {
            uriConsentRequired: {
              authorizationUri: 'https://example.com/auth',
              consentNonce: 'nonce-1',
            },
          },
    );
    const provider = new AgentIdentityCredentialsProvider({client});
    vi.useFakeTimers();

    const pending = provider.getAuthCredential(
      createAuthScheme(),
      createContext(),
    );
    await vi.advanceTimersByTimeAsync(11000);
    const credential = await pending;

    expect(credential.authType).toBe(AuthCredentialTypes.OAUTH2);
    expect(credential.oauth2).toEqual({
      authUri: 'https://example.com/auth',
      nonce: 'nonce-1',
    });
  });
});

describe('isConsentCompleted', () => {
  it('is false when the context has no function call id', () => {
    const context = createContext({
      events: [
        credentialCallEvent({
          id: 'auth-req-1',
          name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
          args: {functionCallId: 'call-123'},
        }),
        credentialResponseEvent('auth-req-1'),
      ],
    });

    expect(isConsentCompleted(context)).toBe(false);
  });

  it('is false when the answered call belongs to another tool call', () => {
    const context = createContext({
      functionCallId: 'call-123',
      events: [
        credentialCallEvent({
          id: 'auth-req-1',
          name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
          args: {functionCallId: 'another-call'},
        }),
        credentialResponseEvent('auth-req-1'),
      ],
    });

    expect(isConsentCompleted(context)).toBe(false);
  });

  it('is false when nothing answered the credential request', () => {
    const context = createContext({
      functionCallId: 'call-123',
      events: [
        credentialCallEvent({
          id: 'auth-req-1',
          name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
          args: {functionCallId: 'call-123'},
        }),
      ],
    });

    expect(isConsentCompleted(context)).toBe(false);
  });

  it('ignores calls with no id, calls with no args and other tools', () => {
    const context = createContext({
      functionCallId: 'call-123',
      events: [
        credentialCallEvent({
          name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
          args: {functionCallId: 'call-123'},
        }),
        credentialCallEvent({
          id: 'auth-req-2',
          name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
        }),
        credentialCallEvent({
          id: 'auth-req-3',
          name: 'some_other_tool',
          args: {functionCallId: 'call-123'},
        }),
        credentialResponseEvent('auth-req-2'),
        credentialResponseEvent('auth-req-3'),
        createEvent({
          author: 'user',
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  response: {},
                },
              },
              {
                functionResponse: {
                  id: 'auth-req-3',
                  name: 'some_other_tool',
                  response: {},
                },
              },
            ],
          },
        }),
      ],
    });

    expect(isConsentCompleted(context)).toBe(false);
  });
});

describe('RestAgentIdentityCredentialsClient', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('surfaces the status and body of a non-2xx response', async () => {
    fetchMock.mockResolvedValue(
      new Response('provider not found', {status: 404}),
    );
    const client = new RestAgentIdentityCredentialsClient();

    await expect(
      client.retrieveCredentials(AUTH_PROVIDER_NAME, {userId: 'user'}),
    ).rejects.toThrow(
      'Agent Identity Credentials request failed with status 404: ' +
        'provider not found',
    );
  });

  it('sends the access token and the JSON content type', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(bearerSuccess()), {status: 200}),
    );
    const client = new RestAgentIdentityCredentialsClient();

    await client.retrieveCredentials(AUTH_PROVIDER_NAME, {userId: 'user'});

    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer fake-token');
    expect(headers.get('content-type')).toBe('application/json');
  });
});
