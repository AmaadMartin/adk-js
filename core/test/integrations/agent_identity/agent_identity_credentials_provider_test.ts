/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python@main, `tests/unittests/integrations/agent_identity/
 * test_agent_identity_credentials_provider.py`. The `it()` names keep the
 * Python test names.
 */

import {
  AuthCredentialTypes,
  Event,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  createEvent,
} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {RestAgentIdentityCredentialsClient} from '../../../src/integrations/agent_identity/agent_identity_credentials_client.js';
import {AgentIdentityCredentialsProvider} from '../../../src/integrations/agent_identity/agent_identity_credentials_provider.js';
import {
  AUTH_PROVIDER_NAME,
  FailingCredentialsClient,
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

const RETRIEVE_URL =
  `https://agentidentitycredentials.googleapis.com/v1/` +
  `${AUTH_PROVIDER_NAME}/credentials:retrieve`;

/** The call/response pair a completed consent leaves in the session. */
function consentCompletedEvents(functionCallId: string): Event[] {
  return [
    createEvent({
      author: 'agent',
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'auth-req-1',
              name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
              args: {functionCallId},
            },
          },
        ],
      },
    }),
    createEvent({
      author: 'user',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'auth-req-1',
              name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
              response: {},
            },
          },
        ],
      },
    }),
  ];
}

describe('AgentIdentityCredentialsProvider', () => {
  const authScheme = createAuthScheme();
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('test_get_client_uses_rest_transport', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(bearerSuccess()), {status: 200}),
    );
    const provider = new AgentIdentityCredentialsProvider();

    await provider.getAuthCredential(authScheme, createContext());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(RETRIEVE_URL);
    expect(init?.method).toBe('POST');
    const body = init?.body;
    if (typeof body !== 'string') {
      expect.fail('expected a JSON request body');
    }
    expect(JSON.parse(body)).toEqual({
      userId: 'user',
      scopes: ['test-scope'],
      continueUri: 'https://example.com/continue',
    });
  });

  it('test_get_auth_credential_reuses_client_on_same_thread', async () => {
    // A Response body reads once, so each call needs its own.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(bearerSuccess()), {status: 200}),
      ),
    );
    const provider = new AgentIdentityCredentialsProvider();
    const context = createContext();

    await provider.getAuthCredential(authScheme, context);
    await provider.getAuthCredential(authScheme, context);

    // Two requests, but only one client: the second call reuses the first
    // client rather than resolving credentials again.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(GoogleAuth)).toHaveBeenCalledTimes(1);
  });

  it('test_get_client_with_env_var', async () => {
    vi.stubEnv('AGENT_IDENTITY_CREDENTIALS_TARGET_HOST', 'some-host');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(bearerSuccess()), {status: 200}),
    );
    const client = new RestAgentIdentityCredentialsClient();

    await client.retrieveCredentials(AUTH_PROVIDER_NAME, {userId: 'user'});

    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://some-host/v1/${AUTH_PROVIDER_NAME}/credentials:retrieve`,
    );
  });

  it('test_get_auth_credential_raises_error_if_context_is_missing', async () => {
    const provider = new AgentIdentityCredentialsProvider({
      client: new FakeCredentialsClient(() => bearerSuccess()),
    });

    await expect(provider.getAuthCredential(authScheme)).rejects.toThrow(
      'GcpAuthProvider requires a context with a valid user_id.',
    );
  });

  it('test_get_auth_credential_raises_error_if_user_id_is_missing', async () => {
    const provider = new AgentIdentityCredentialsProvider({
      client: new FakeCredentialsClient(() => bearerSuccess()),
    });

    await expect(
      provider.getAuthCredential(authScheme, createContext({userId: ''})),
    ).rejects.toThrow(
      'GcpAuthProvider requires a context with a valid user_id.',
    );
  });

  it('test_get_auth_credential_rejects_unsupported_response', async () => {
    const provider = new AgentIdentityCredentialsProvider({
      client: new FakeCredentialsClient(() => ({})),
    });

    await expect(
      provider.getAuthCredential(authScheme, createContext()),
    ).rejects.toThrow(
      'Agent Identity Credentials service returned an unsupported state.',
    );
  });

  it('test_get_auth_credential_returns_credential_if_available_immediately', async () => {
    const client = new FakeCredentialsClient(() => bearerSuccess());
    const provider = new AgentIdentityCredentialsProvider({client});

    const credential = await provider.getAuthCredential(
      authScheme,
      createContext(),
    );

    expect(credential.authType).toBe(AuthCredentialTypes.HTTP);
    expect(credential.http?.scheme).toBe('Bearer');
    expect(credential.http?.credentials.token).toBe('test-token');
    expect(client.requests).toHaveLength(1);
  });

  it('test_get_auth_credential_raises_error_if_upstream_returns_empty_header', async () => {
    const provider = new AgentIdentityCredentialsProvider({
      client: new FakeCredentialsClient(() => ({
        success: {header: '', token: 'test-token'},
      })),
    });

    await expect(
      provider.getAuthCredential(authScheme, createContext()),
    ).rejects.toThrow(
      'Received either empty header or token from Agent Identity Credentials' +
        ' service.',
    );
  });

  it('test_get_auth_credential_raises_error_if_upstream_returns_empty_token', async () => {
    const provider = new AgentIdentityCredentialsProvider({
      client: new FakeCredentialsClient(() => ({
        success: {header: 'Authorization: Bearer', token: ''},
      })),
    });

    await expect(
      provider.getAuthCredential(authScheme, createContext()),
    ).rejects.toThrow(
      'Received either empty header or token from Agent Identity Credentials' +
        ' service.',
    );
  });

  it('test_get_auth_credential_returns_credential_if_upstream_returns_custom_header', async () => {
    const provider = new AgentIdentityCredentialsProvider({
      client: new FakeCredentialsClient(() => ({
        success: {header: 'some-x-api-key', token: 'test-token'},
      })),
    });

    const credential = await provider.getAuthCredential(
      authScheme,
      createContext(),
    );

    expect(credential.authType).toBe(AuthCredentialTypes.HTTP);
    expect(credential.http?.scheme).toBe('');
    expect(credential.http?.credentials.token).toBeUndefined();
    expect(credential.http?.additionalHeaders).toEqual({
      'some-x-api-key': 'test-token',
      'X-GOOG-API-KEY': 'test-token',
    });
  });

  it('test_get_auth_credential_raises_error_if_upstream_operation_errors', async () => {
    const provider = new AgentIdentityCredentialsProvider({
      client: new FakeCredentialsClient(() => ({consentRejected: {}})),
    });

    await expect(
      provider.getAuthCredential(authScheme, createContext()),
    ).rejects.toThrow('Operation failed: User consent rejected.');
  });

  it('test_get_auth_credential_raises_error_if_upstream_call_fails', async () => {
    const provider = new AgentIdentityCredentialsProvider({
      client: new FailingCredentialsClient(new Error('API Quota Exhausted')),
    });

    const error = await provider
      .getAuthCredential(authScheme, createContext())
      .catch((reason: unknown) => reason);

    if (!(error instanceof Error)) {
      expect.fail('expected the provider to reject with an Error');
    }
    expect(error.message).toBe(
      `Failed to retrieve credential for user 'user' on provider ` +
        `'${AUTH_PROVIDER_NAME}'.`,
    );
    const cause = error.cause;
    if (!(cause instanceof Error)) {
      expect.fail('expected the original error as the cause');
    }
    expect(cause.message).toBe('API Quota Exhausted');
  });

  it('test_get_auth_credential_raises_error_if_polling_times_out', async () => {
    const client = new FakeCredentialsClient(() => ({pending: {}}));
    const provider = new AgentIdentityCredentialsProvider({client});
    vi.useFakeTimers();

    const pending = provider
      .getAuthCredential(authScheme, createContext())
      .catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(11000);
    const error = await pending;

    if (!(error instanceof Error)) {
      expect.fail('expected the provider to reject with an Error');
    }
    expect(error.message).toBe(
      `Failed to retrieve credential for user 'user' on provider ` +
        `'${AUTH_PROVIDER_NAME}'.`,
    );
    const cause = error.cause;
    if (!(cause instanceof Error)) {
      expect.fail('expected the timeout as the cause');
    }
    expect(cause.message).toBe('Timeout waiting for credentials.');
    // One initial call, then one per second for the ten-second budget.
    expect(client.requests).toHaveLength(11);
  });

  it('test_get_auth_credential_initiates_user_consent', async () => {
    const provider = new AgentIdentityCredentialsProvider({
      client: new FakeCredentialsClient(() => ({
        uriConsentRequired: {
          authorizationUri: 'https://example.com/auth',
          consentNonce: 'sample-nonce-123',
        },
      })),
    });
    const context = createContext({functionCallId: 'call_123'});

    const credential = await provider.getAuthCredential(authScheme, context);

    expect(credential.authType).toBe(AuthCredentialTypes.OAUTH2);
    expect(credential.oauth2).toEqual({
      authUri: 'https://example.com/auth',
      nonce: 'sample-nonce-123',
    });
  });

  it('test_get_auth_credential_returns_fresh_auth_uri_for_repeated_requests', async () => {
    const client = new FakeCredentialsClient((callIndex) => ({
      uriConsentRequired:
        callIndex === 0
          ? {
              authorizationUri: 'https://example.com/auth',
              consentNonce: 'initial-nonce-123',
            }
          : {
              authorizationUri: 'https://example.com/auth_new',
              consentNonce: 'fresh-nonce-456',
            },
    }));
    const provider = new AgentIdentityCredentialsProvider({client});
    const context = createContext({functionCallId: 'call_123'});

    const first = await provider.getAuthCredential(authScheme, context);
    const second = await provider.getAuthCredential(authScheme, context);

    expect(client.requests).toHaveLength(2);
    expect(first.oauth2).toEqual({
      authUri: 'https://example.com/auth',
      nonce: 'initial-nonce-123',
    });
    expect(second.oauth2).toEqual({
      authUri: 'https://example.com/auth_new',
      nonce: 'fresh-nonce-456',
    });
  });

  it('test_get_auth_credential_returns_token_if_consent_was_completed', async () => {
    const provider = new AgentIdentityCredentialsProvider({
      client: new FakeCredentialsClient(() => bearerSuccess()),
    });
    const context = createContext({
      functionCallId: 'call-123',
      events: consentCompletedEvents('call-123'),
    });

    const credential = await provider.getAuthCredential(authScheme, context);

    expect(credential.authType).toBe(AuthCredentialTypes.HTTP);
    expect(credential.http?.scheme).toBe('Bearer');
    expect(credential.http?.credentials.token).toBe('test-token');
  });

  it('test_get_auth_credential_raises_error_if_consent_canceled', async () => {
    const provider = new AgentIdentityCredentialsProvider({
      client: new FakeCredentialsClient(() => ({
        uriConsentRequired: {
          authorizationUri: 'https://example.com/auth',
          consentNonce: 'sample-nonce',
        },
      })),
    });
    const context = createContext({
      functionCallId: 'call-123',
      events: consentCompletedEvents('call-123'),
    });

    await expect(
      provider.getAuthCredential(authScheme, context),
    ).rejects.toThrow('Failed to retrieve consent based credential.');
  });
});
