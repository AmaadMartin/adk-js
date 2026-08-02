/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredentialTypes, GCP_AUTH_PROVIDER_SCHEME_TYPE} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  AgentIdentityCredentialsClient,
  RetrieveCredentialsResponse,
} from '../../../src/integrations/agent_identity/agent_identity_credentials_client.js';
import {AgentIdentityCredentialsProvider} from '../../../src/integrations/agent_identity/agent_identity_credentials_provider.js';
import {GcpAuthProviderScheme} from '../../../src/integrations/agent_identity/gcp_auth_provider_scheme.js';
import {
  captureError,
  causeOf,
  consentCompletedEvents,
  contextWithEvents,
} from './agent_identity_test_utils.js';

const PROVIDER_NAME =
  'projects/test-project/locations/global/authProviders/test-provider';
const SERVICE_LABEL = 'Agent Identity Credentials service';
const RETRIEVAL_FAILED = `Failed to retrieve credential for user 'user' on provider '${PROVIDER_NAME}'.`;

const AUTH_SCHEME: GcpAuthProviderScheme = {
  type: GCP_AUTH_PROVIDER_SCHEME_TYPE,
  name: PROVIDER_NAME,
  scopes: ['test-scope'],
  continueUri: 'https://example.com/continue',
};

const BEARER_SUCCESS: RetrieveCredentialsResponse = {
  success: {header: 'Authorization: Bearer', token: 'test-token'},
};

const CONTEXT = contextWithEvents([]);

describe('AgentIdentityCredentialsProvider', () => {
  let client: {
    retrieveCredentials: ReturnType<typeof vi.fn>;
  } & AgentIdentityCredentialsClient;
  let provider: AgentIdentityCredentialsProvider;

  beforeEach(() => {
    client = {retrieveCredentials: vi.fn()};
    provider = new AgentIdentityCredentialsProvider(client);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when no context was supplied', async () => {
    await expect(provider.getAuthCredential(AUTH_SCHEME)).rejects.toThrow(
      'GcpAuthProvider requires a context with a valid userId.',
    );
    expect(client.retrieveCredentials).not.toHaveBeenCalled();
  });

  it('throws when the context has no user id', async () => {
    await expect(
      provider.getAuthCredential(AUTH_SCHEME, {functionCallId: 'call-123'}),
    ).rejects.toThrow(
      'GcpAuthProvider requires a context with a valid userId.',
    );
  });

  it('returns a bearer credential available immediately', async () => {
    client.retrieveCredentials.mockResolvedValue(BEARER_SUCCESS);

    const credential = await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);

    expect(credential?.authType).toBe(AuthCredentialTypes.HTTP);
    expect(credential?.http?.scheme).toBe('Bearer');
    expect(credential?.http?.credentials.token).toBe('test-token');
    expect(client.retrieveCredentials).toHaveBeenCalledTimes(1);
  });

  it('forwards the scheme configuration to the service', async () => {
    client.retrieveCredentials.mockResolvedValue(BEARER_SUCCESS);

    await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);

    expect(client.retrieveCredentials).toHaveBeenCalledWith(PROVIDER_NAME, {
      userId: 'user',
      scopes: ['test-scope'],
      continueUri: 'https://example.com/continue',
    });
  });

  it('sends an empty continue URI when the scheme omits it', async () => {
    client.retrieveCredentials.mockResolvedValue(BEARER_SUCCESS);

    await provider.getAuthCredential(
      {type: GCP_AUTH_PROVIDER_SCHEME_TYPE, name: PROVIDER_NAME},
      CONTEXT,
    );

    expect(client.retrieveCredentials).toHaveBeenCalledWith(PROVIDER_NAME, {
      userId: 'user',
      scopes: undefined,
      continueUri: '',
    });
  });

  it('throws when the service returns an empty header', async () => {
    client.retrieveCredentials.mockResolvedValue({
      success: {header: '', token: 'test-token'},
    });

    await expect(
      provider.getAuthCredential(AUTH_SCHEME, CONTEXT),
    ).rejects.toThrow(
      `Received either empty header or token from ${SERVICE_LABEL}.`,
    );
  });

  it('throws when the service returns an empty token', async () => {
    client.retrieveCredentials.mockResolvedValue({
      success: {header: 'Authorization: Bearer', token: ''},
    });

    await expect(
      provider.getAuthCredential(AUTH_SCHEME, CONTEXT),
    ).rejects.toThrow(
      `Received either empty header or token from ${SERVICE_LABEL}.`,
    );
  });

  it('returns a custom-header credential', async () => {
    client.retrieveCredentials.mockResolvedValue({
      success: {header: 'some-x-api-key', token: 'test-token'},
    });

    const credential = await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);

    expect(credential?.authType).toBe(AuthCredentialTypes.HTTP);
    expect(credential?.http?.scheme).toBe('');
    expect(credential?.http?.credentials.token).toBeUndefined();
    expect(credential?.http?.additionalHeaders).toEqual({
      'some-x-api-key': 'test-token',
      'X-GOOG-API-KEY': 'test-token',
    });
  });

  it('throws when the user rejected consent', async () => {
    client.retrieveCredentials.mockResolvedValue({consentRejected: {}});

    await expect(
      provider.getAuthCredential(AUTH_SCHEME, CONTEXT),
    ).rejects.toThrow('Operation failed: User consent rejected.');
  });

  it('wraps an upstream failure and keeps it as the cause', async () => {
    client.retrieveCredentials.mockRejectedValue(
      new Error('API Quota Exhausted'),
    );

    const error = await captureError(
      provider.getAuthCredential(AUTH_SCHEME, CONTEXT),
    );

    expect(error.message).toBe(RETRIEVAL_FAILED);
    expect(causeOf(error).message).toBe('API Quota Exhausted');
  });

  it('gives up on a request that stays pending', async () => {
    vi.useFakeTimers();
    client.retrieveCredentials.mockResolvedValue({pending: {}});

    const [error] = await Promise.all([
      captureError(provider.getAuthCredential(AUTH_SCHEME, CONTEXT)),
      vi.runAllTimersAsync(),
    ]);

    expect(error.message).toBe(RETRIEVAL_FAILED);
    expect(causeOf(error).message).toBe('Timeout waiting for credentials.');
    // One initial request plus 10s deadline / 1s interval, and never more.
    expect(client.retrieveCredentials).toHaveBeenCalledTimes(11);
  });

  it('returns the credential polled after a pending response', async () => {
    client.retrieveCredentials
      .mockResolvedValueOnce({pending: {}})
      .mockResolvedValue(BEARER_SUCCESS);

    const credential = await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);

    expect(credential?.http?.credentials.token).toBe('test-token');
    expect(client.retrieveCredentials).toHaveBeenCalledTimes(2);
  });

  it('sleeps once between two pending polls', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    client.retrieveCredentials
      .mockResolvedValueOnce({pending: {}})
      .mockResolvedValueOnce({pending: {}})
      .mockResolvedValue(BEARER_SUCCESS);

    const [credential] = await Promise.all([
      provider.getAuthCredential(AUTH_SCHEME, CONTEXT),
      vi.runAllTimersAsync(),
    ]);

    expect(credential?.http?.credentials.token).toBe('test-token');
    expect(client.retrieveCredentials).toHaveBeenCalledTimes(3);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
  });

  it('surfaces a consent rejection found while polling unwrapped', async () => {
    client.retrieveCredentials
      .mockResolvedValueOnce({pending: {}})
      .mockResolvedValue({consentRejected: {}});

    const error = await captureError(
      provider.getAuthCredential(AUTH_SCHEME, CONTEXT),
    );

    expect(error.message).toBe('Operation failed: User consent rejected.');
    expect(error.cause).toBeUndefined();
  });

  it('falls through to consent using the polled response', async () => {
    client.retrieveCredentials
      .mockResolvedValueOnce({pending: {}})
      .mockResolvedValue({
        uriConsentRequired: {
          authorizationUri: 'https://example.com/polled',
          consentNonce: 'polled-nonce',
        },
      });

    const credential = await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);

    expect(credential?.authType).toBe(AuthCredentialTypes.OAUTH2);
    expect(credential?.oauth2).toEqual({
      authUri: 'https://example.com/polled',
      nonce: 'polled-nonce',
    });
    expect(client.retrieveCredentials).toHaveBeenCalledTimes(2);
  });

  it('initiates user consent when the service asks for it', async () => {
    client.retrieveCredentials.mockResolvedValue({
      uriConsentRequired: {
        authorizationUri: 'https://example.com/auth',
        consentNonce: 'sample-nonce-123',
      },
    });

    const credential = await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);

    expect(credential?.authType).toBe(AuthCredentialTypes.OAUTH2);
    expect(credential?.oauth2).toEqual({
      authUri: 'https://example.com/auth',
      nonce: 'sample-nonce-123',
    });
    expect(credential?.http).toBeUndefined();
  });

  it('returns a fresh auth URI for a repeated request', async () => {
    client.retrieveCredentials.mockResolvedValueOnce({
      uriConsentRequired: {
        authorizationUri: 'https://example.com/auth',
        consentNonce: 'initial-nonce-123',
      },
    });

    const first = await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);
    expect(first?.oauth2?.authUri).toBe('https://example.com/auth');
    expect(first?.oauth2?.nonce).toBe('initial-nonce-123');

    client.retrieveCredentials.mockResolvedValueOnce({
      uriConsentRequired: {
        authorizationUri: 'https://example.com/auth_new',
        consentNonce: 'fresh-nonce-456',
      },
    });

    const second = await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);

    expect(second?.oauth2?.authUri).toBe('https://example.com/auth_new');
    expect(second?.oauth2?.nonce).toBe('fresh-nonce-456');
    expect(client.retrieveCredentials).toHaveBeenCalledTimes(2);
  });

  it('returns the token once consent completed', async () => {
    client.retrieveCredentials.mockResolvedValue(BEARER_SUCCESS);

    const credential = await provider.getAuthCredential(
      AUTH_SCHEME,
      contextWithEvents(consentCompletedEvents('call-123')),
    );

    expect(credential?.http?.scheme).toBe('Bearer');
    expect(credential?.http?.credentials.token).toBe('test-token');
  });

  it('throws when consent completed yet is still demanded', async () => {
    client.retrieveCredentials.mockResolvedValue({
      uriConsentRequired: {
        authorizationUri: 'https://example.com/auth',
        consentNonce: 'sample-nonce',
      },
    });

    await expect(
      provider.getAuthCredential(
        AUTH_SCHEME,
        contextWithEvents(consentCompletedEvents('call-123')),
      ),
    ).rejects.toThrow('Failed to retrieve consent based credential.');
  });

  it('resolves to undefined for a response in no known state', async () => {
    client.retrieveCredentials.mockResolvedValue({});

    await expect(
      provider.getAuthCredential(AUTH_SCHEME, CONTEXT),
    ).resolves.toBeUndefined();
  });

  it('builds a REST client when none is injected', () => {
    expect(() => new AgentIdentityCredentialsProvider()).not.toThrow();
  });
});
