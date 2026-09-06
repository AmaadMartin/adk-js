/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `it()` names of the first describe are the adk-python test names, ported
 * from `tests/unittests/integrations/agent_identity/
 * test_iam_connector_credentials_provider.py` at adk-python@main. The describes
 * after it cover paths the reference tests do not reach.
 */

import {
  AuthCredentialTypes,
  Event,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  createEvent,
} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {RestIamConnectorCredentialsClient} from '../../../src/integrations/agent_identity/iam_connector_credentials_client.js';
import {IamConnectorCredentialsProvider} from '../../../src/integrations/agent_identity/iam_connector_credentials_provider.js';
import {
  CONNECTOR_NAME,
  FailingConnectorClient,
  FakeConnectorClient,
  bearerOperation,
  createConnectorScheme,
  createContext,
  pendingOperation,
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
  `https://iamconnectorcredentials.googleapis.com/v1alpha/` +
  `${CONNECTOR_NAME}/credentials:retrieve`;

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

describe('IamConnectorCredentialsProvider', () => {
  const authScheme = createConnectorScheme();
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
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
      new Response(JSON.stringify(bearerOperation()), {status: 200}),
    );
    const provider = new IamConnectorCredentialsProvider();

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
      forceRefresh: false,
      scopes: ['test-scope'],
      continueUri: 'https://example.com/continue',
    });
  });

  it('test_get_auth_credential_reuses_client_on_same_thread', async () => {
    // A Response body reads once, so each call needs its own.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify(bearerOperation()), {status: 200}),
      ),
    );
    vi.mocked(GoogleAuth).mockClear();
    const provider = new IamConnectorCredentialsProvider();
    const context = createContext();

    await provider.getAuthCredential(authScheme, context);
    await provider.getAuthCredential(authScheme, context);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(GoogleAuth)).toHaveBeenCalledTimes(1);
  });

  it('test_get_client_with_env_var', async () => {
    vi.stubEnv('IAM_CONNECTOR_CREDENTIALS_TARGET_HOST', 'some-host');
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(bearerOperation()), {status: 200}),
    );
    const client = new RestIamConnectorCredentialsClient();

    await client.retrieveCredentials(CONNECTOR_NAME, {
      userId: 'user',
      forceRefresh: false,
    });

    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://some-host/v1alpha/${CONNECTOR_NAME}/credentials:retrieve`,
    );
  });

  it('test_get_auth_credential_raises_error_if_context_is_missing', async () => {
    const provider = new IamConnectorCredentialsProvider({
      client: new FakeConnectorClient(() => bearerOperation()),
    });

    await expect(provider.getAuthCredential(authScheme)).rejects.toThrow(
      'GcpAuthProvider requires a context with a valid user_id.',
    );
  });

  it('test_get_auth_credential_raises_error_if_user_id_is_missing', async () => {
    const provider = new IamConnectorCredentialsProvider({
      client: new FakeConnectorClient(() => bearerOperation()),
    });

    await expect(
      provider.getAuthCredential(authScheme, createContext({userId: ''})),
    ).rejects.toThrow(
      'GcpAuthProvider requires a context with a valid user_id.',
    );
  });

  it('test_get_auth_credential_rejects_missing_completed_response', async () => {
    const provider = new IamConnectorCredentialsProvider({
      client: new FakeConnectorClient(() => ({done: true})),
    });

    await expect(
      provider.getAuthCredential(authScheme, createContext()),
    ).rejects.toThrow(
      'IAM Connector Credentials operation completed without a response.',
    );
  });

  it('test_get_auth_credential_returns_credential_if_available_immediately', async () => {
    const client = new FakeConnectorClient(() => bearerOperation());
    const provider = new IamConnectorCredentialsProvider({client});

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
    const provider = new IamConnectorCredentialsProvider({
      client: new FakeConnectorClient(() => ({
        done: true,
        response: {header: '', token: 'test-token'},
      })),
    });

    await expect(
      provider.getAuthCredential(authScheme, createContext()),
    ).rejects.toThrow(
      'Received either empty header or token from IAM Connector Credentials' +
        ' service.',
    );
  });

  it('test_get_auth_credential_raises_error_if_upstream_returns_empty_token', async () => {
    const provider = new IamConnectorCredentialsProvider({
      client: new FakeConnectorClient(() => ({
        done: true,
        response: {header: 'Authorization: Bearer', token: ''},
      })),
    });

    await expect(
      provider.getAuthCredential(authScheme, createContext()),
    ).rejects.toThrow(
      'Received either empty header or token from IAM Connector Credentials' +
        ' service.',
    );
  });

  it('test_get_auth_credential_returns_credential_if_upstream_returns_custom_header', async () => {
    const provider = new IamConnectorCredentialsProvider({
      client: new FakeConnectorClient(() => ({
        done: true,
        response: {header: 'some-x-api-key', token: 'test-token'},
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
    const provider = new IamConnectorCredentialsProvider({
      client: new FakeConnectorClient(() => ({
        done: false,
        error: {code: 13, message: 'OAuth server error'},
      })),
    });

    await expect(
      provider.getAuthCredential(authScheme, createContext()),
    ).rejects.toThrow('Operation failed: OAuth server error');
  });

  it('test_get_auth_credential_raises_error_if_upstream_call_fails', async () => {
    const provider = new IamConnectorCredentialsProvider({
      client: new FailingConnectorClient(new Error('API Quota Exhausted')),
    });

    const error = await provider
      .getAuthCredential(authScheme, createContext())
      .catch((reason: unknown) => reason);

    if (!(error instanceof Error)) {
      expect.fail('expected the provider to reject with an Error');
    }
    expect(error.message).toBe(
      `Failed to retrieve credential for user 'user' on connector ` +
        `'${CONNECTOR_NAME}'.`,
    );
    const cause = error.cause;
    if (!(cause instanceof Error)) {
      expect.fail('expected the original error as the cause');
    }
    expect(cause.message).toBe('API Quota Exhausted');
  });

  it('test_get_auth_credential_raises_error_if_polling_times_out', async () => {
    const client = new FakeConnectorClient(() =>
      pendingOperation({consentPending: {}}),
    );
    const provider = new IamConnectorCredentialsProvider({client});
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
      `Failed to retrieve credential for user 'user' on connector ` +
        `'${CONNECTOR_NAME}'.`,
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
    const provider = new IamConnectorCredentialsProvider({
      client: new FakeConnectorClient(() =>
        pendingOperation({
          uriConsentRequired: {
            authorizationUri: 'https://example.com/auth',
            consentNonce: 'sample-nonce-123',
          },
        }),
      ),
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
    const client = new FakeConnectorClient((callIndex) =>
      pendingOperation({
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
      }),
    );
    const provider = new IamConnectorCredentialsProvider({client});
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
    const provider = new IamConnectorCredentialsProvider({
      client: new FakeConnectorClient(() => ({
        ...bearerOperation(),
        metadata: {uriConsentRequired: {}},
      })),
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
    const provider = new IamConnectorCredentialsProvider({
      client: new FakeConnectorClient(() =>
        pendingOperation({
          uriConsentRequired: {
            authorizationUri: 'https://example.com/auth',
            consentNonce: 'sample-nonce',
          },
        }),
      ),
    });
    const context = createContext({
      functionCallId: 'call-123',
      events: consentCompletedEvents('call-123'),
    });

    await expect(
      provider.getAuthCredential(authScheme, context),
    ).rejects.toThrow('Failed to retrieve consent based credential.');
  });

  it('test_get_auth_credential_handles_consent_pending_state_correctly', async () => {
    const client = new FakeConnectorClient((callIndex) =>
      callIndex === 0
        ? pendingOperation({consentPending: {}})
        : bearerOperation('valid-token'),
    );
    const provider = new IamConnectorCredentialsProvider({client});

    const credential = await provider.getAuthCredential(
      authScheme,
      createContext(),
    );

    expect(credential.http?.credentials.token).toBe('valid-token');
    expect(client.requests).toHaveLength(2);
  });

  it('test_get_auth_credential_polling_succeeds_before_timeout', async () => {
    const client = new FakeConnectorClient((callIndex) =>
      callIndex < 2
        ? pendingOperation({consentPending: {}})
        : bearerOperation('valid-token'),
    );
    const provider = new IamConnectorCredentialsProvider({client});
    vi.useFakeTimers();

    const pending = provider.getAuthCredential(authScheme, createContext());
    await vi.advanceTimersByTimeAsync(1000);
    const credential = await pending;

    expect(credential.http?.credentials.token).toBe('valid-token');
    expect(client.requests).toHaveLength(3);
  });
});

describe('the retrieve request', () => {
  it('always asks the service not to force a refresh', async () => {
    const client = new FakeConnectorClient(() => bearerOperation());
    const provider = new IamConnectorCredentialsProvider({client});

    await provider.getAuthCredential(createConnectorScheme(), createContext());

    expect(client.connectors).toEqual([CONNECTOR_NAME]);
    expect(client.requests[0]).toStrictEqual({
      userId: 'user',
      forceRefresh: false,
      scopes: ['test-scope'],
      continueUri: 'https://example.com/continue',
    });
  });

  it('omits the scopes and continue URI the scheme does not set', async () => {
    const client = new FakeConnectorClient(() => bearerOperation());
    const provider = new IamConnectorCredentialsProvider({client});
    const authScheme = createConnectorScheme({
      scopes: undefined,
      continueUri: undefined,
    });

    await provider.getAuthCredential(authScheme, createContext());

    expect(client.requests[0]).toStrictEqual({
      userId: 'user',
      forceRefresh: false,
    });
  });
});

describe('an operation the provider cannot serve', () => {
  it.each([
    ['carries no metadata at all', {}],
    ['reports only a create time', {createTime: '2026-01-01T00:00:00Z'}],
    ['reports a rejected consent', {consentRejected: {}}],
  ])('rejects an operation that %s', async (_label, metadata) => {
    const provider = new IamConnectorCredentialsProvider({
      client: new FakeConnectorClient(() => pendingOperation(metadata)),
    });

    await expect(
      provider.getAuthCredential(createConnectorScheme(), createContext()),
    ).rejects.toThrow(
      'IAM Connector Credentials service returned an unsupported state.',
    );
  });
});

describe('polling', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports an operation that fails while polling, without wrapping it', async () => {
    const provider = new IamConnectorCredentialsProvider({
      client: new FakeConnectorClient((callIndex) =>
        callIndex === 0
          ? pendingOperation({consentPending: {}})
          : {done: true, error: {code: 13, message: 'OAuth server error'}},
      ),
    });
    vi.useFakeTimers();

    const pending = provider
      .getAuthCredential(createConnectorScheme(), createContext())
      .catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await pending;

    if (!(error instanceof Error)) {
      expect.fail('expected the provider to reject with an Error');
    }
    expect(error.message).toBe('Operation failed: OAuth server error');
    expect(error.cause).toBeUndefined();
  });

  it('reports a completed poll that carries no credentials', async () => {
    const provider = new IamConnectorCredentialsProvider({
      client: new FakeConnectorClient((callIndex) =>
        callIndex === 0 ? pendingOperation({consentPending: {}}) : {done: true},
      ),
    });
    vi.useFakeTimers();

    const pending = provider
      .getAuthCredential(createConnectorScheme(), createContext())
      .catch((reason: unknown) => reason);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await pending;

    if (!(error instanceof Error)) {
      expect.fail('expected the provider to reject with an Error');
    }
    expect(error.message).toBe(
      'IAM Connector Credentials operation completed without a response.',
    );
    expect(error.cause).toBeUndefined();
  });
});
