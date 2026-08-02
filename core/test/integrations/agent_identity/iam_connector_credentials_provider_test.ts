/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredentialTypes, GCP_AUTH_PROVIDER_SCHEME_TYPE} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {GcpAuthProviderScheme} from '../../../src/integrations/agent_identity/gcp_auth_provider_scheme.js';
import {
  IamConnectorCredentialsClient,
  Operation,
} from '../../../src/integrations/agent_identity/iam_connector_credentials_client.js';
import {IamConnectorCredentialsProvider} from '../../../src/integrations/agent_identity/iam_connector_credentials_provider.js';
import {
  captureError,
  causeOf,
  consentCompletedEvents,
  contextWithEvents,
} from './agent_identity_test_utils.js';

const CONNECTOR_NAME =
  'projects/test-project/locations/global/connectors/test-connector';
const SERVICE_LABEL = 'IAM Connector Credentials service';
const RETRIEVAL_FAILED = `Failed to retrieve credential for user 'user' on connector '${CONNECTOR_NAME}'.`;

const AUTH_SCHEME: GcpAuthProviderScheme = {
  type: GCP_AUTH_PROVIDER_SCHEME_TYPE,
  name: CONNECTOR_NAME,
  scopes: ['test-scope'],
  continueUri: 'https://example.com/continue',
};

const DONE_WITH_TOKEN: Operation = {
  done: true,
  response: {header: 'Authorization: Bearer', token: 'test-token'},
};

const CONSENT_PENDING: Operation = {
  done: false,
  metadata: {consentPending: {}},
};

const CONTEXT = contextWithEvents([]);

describe('IamConnectorCredentialsProvider', () => {
  let client: {
    retrieveCredentials: ReturnType<typeof vi.fn>;
  } & IamConnectorCredentialsClient;
  let provider: IamConnectorCredentialsProvider;

  beforeEach(() => {
    client = {retrieveCredentials: vi.fn()};
    provider = new IamConnectorCredentialsProvider(client);
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

  it('returns a bearer credential from a completed operation', async () => {
    client.retrieveCredentials.mockResolvedValue(DONE_WITH_TOKEN);

    const credential = await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);

    expect(credential?.authType).toBe(AuthCredentialTypes.HTTP);
    expect(credential?.http?.scheme).toBe('Bearer');
    expect(credential?.http?.credentials.token).toBe('test-token');
    expect(client.retrieveCredentials).toHaveBeenCalledTimes(1);
  });

  it('forwards the scheme configuration to the service', async () => {
    client.retrieveCredentials.mockResolvedValue(DONE_WITH_TOKEN);

    await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);

    expect(client.retrieveCredentials).toHaveBeenCalledWith(CONNECTOR_NAME, {
      userId: 'user',
      scopes: ['test-scope'],
      continueUri: 'https://example.com/continue',
      forceRefresh: false,
    });
  });

  it('sends an empty continue URI when the scheme omits it', async () => {
    client.retrieveCredentials.mockResolvedValue(DONE_WITH_TOKEN);

    await provider.getAuthCredential(
      {type: GCP_AUTH_PROVIDER_SCHEME_TYPE, name: CONNECTOR_NAME},
      CONTEXT,
    );

    expect(client.retrieveCredentials).toHaveBeenCalledWith(CONNECTOR_NAME, {
      userId: 'user',
      scopes: undefined,
      continueUri: '',
      forceRefresh: false,
    });
  });

  it('throws when the operation carries an error, before checking done', async () => {
    client.retrieveCredentials.mockResolvedValue({
      done: true,
      error: {code: 7, message: 'OAuth server error'},
      response: {header: 'Authorization: Bearer', token: 'test-token'},
    });

    await expect(
      provider.getAuthCredential(AUTH_SCHEME, CONTEXT),
    ).rejects.toThrow('Operation failed: OAuth server error');
  });

  it('reports an error with no message', async () => {
    client.retrieveCredentials.mockResolvedValue({
      done: true,
      error: {code: 7},
    });

    await expect(
      provider.getAuthCredential(AUTH_SCHEME, CONTEXT),
    ).rejects.toThrow('Operation failed: ');
  });

  it('throws when a completed operation carries no response', async () => {
    client.retrieveCredentials.mockResolvedValue({done: true});

    await expect(
      provider.getAuthCredential(AUTH_SCHEME, CONTEXT),
    ).rejects.toThrow(
      `Received either empty header or token from ${SERVICE_LABEL}.`,
    );
  });

  it('returns a custom-header credential', async () => {
    client.retrieveCredentials.mockResolvedValue({
      done: true,
      response: {header: 'some-x-api-key', token: 'test-token'},
    });

    const credential = await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);

    expect(credential?.http?.scheme).toBe('');
    expect(credential?.http?.additionalHeaders).toEqual({
      'some-x-api-key': 'test-token',
      'X-GOOG-API-KEY': 'test-token',
    });
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

  it('polls a consent-pending operation until it completes', async () => {
    client.retrieveCredentials
      .mockResolvedValueOnce(CONSENT_PENDING)
      .mockResolvedValue(DONE_WITH_TOKEN);

    const credential = await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);

    expect(credential?.http?.credentials.token).toBe('test-token');
    expect(client.retrieveCredentials).toHaveBeenCalledTimes(2);
  });

  it('sleeps once between two pending polls', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    client.retrieveCredentials
      .mockResolvedValueOnce(CONSENT_PENDING)
      .mockResolvedValueOnce(CONSENT_PENDING)
      .mockResolvedValue(DONE_WITH_TOKEN);

    const [credential] = await Promise.all([
      provider.getAuthCredential(AUTH_SCHEME, CONTEXT),
      vi.runAllTimersAsync(),
    ]);

    expect(credential?.http?.credentials.token).toBe('test-token');
    expect(client.retrieveCredentials).toHaveBeenCalledTimes(3);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
  });

  it('surfaces an error found while polling unwrapped', async () => {
    client.retrieveCredentials
      .mockResolvedValueOnce(CONSENT_PENDING)
      .mockResolvedValue({
        done: true,
        error: {message: 'OAuth server error'},
      });

    const error = await captureError(
      provider.getAuthCredential(AUTH_SCHEME, CONTEXT),
    );

    expect(error.message).toBe('Operation failed: OAuth server error');
    expect(error.cause).toBeUndefined();
  });

  it('gives up on an operation that stays consent-pending', async () => {
    vi.useFakeTimers();
    client.retrieveCredentials.mockResolvedValue(CONSENT_PENDING);

    const [error] = await Promise.all([
      captureError(provider.getAuthCredential(AUTH_SCHEME, CONTEXT)),
      vi.runAllTimersAsync(),
    ]);

    expect(error.message).toBe(RETRIEVAL_FAILED);
    expect(causeOf(error).message).toBe('Timeout waiting for credentials.');
    // One initial request plus 10s deadline / 1s interval, and never more.
    expect(client.retrieveCredentials).toHaveBeenCalledTimes(11);
  });

  it('initiates user consent when the operation asks for it', async () => {
    client.retrieveCredentials.mockResolvedValue({
      done: false,
      metadata: {
        uriConsentRequired: {
          authorizationUri: 'https://example.com/auth',
          consentNonce: 'sample-nonce-123',
        },
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
      done: false,
      metadata: {
        uriConsentRequired: {
          authorizationUri: 'https://example.com/auth',
          consentNonce: 'initial-nonce-123',
        },
      },
    });

    const first = await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);
    expect(first?.oauth2?.authUri).toBe('https://example.com/auth');
    expect(first?.oauth2?.nonce).toBe('initial-nonce-123');

    client.retrieveCredentials.mockResolvedValueOnce({
      done: false,
      metadata: {
        uriConsentRequired: {
          authorizationUri: 'https://example.com/auth_new',
          consentNonce: 'fresh-nonce-456',
        },
      },
    });

    const second = await provider.getAuthCredential(AUTH_SCHEME, CONTEXT);

    expect(second?.oauth2?.authUri).toBe('https://example.com/auth_new');
    expect(second?.oauth2?.nonce).toBe('fresh-nonce-456');
    expect(client.retrieveCredentials).toHaveBeenCalledTimes(2);
  });

  it('prefers a completed operation over a pending consent URI', async () => {
    client.retrieveCredentials.mockResolvedValue({
      done: true,
      response: {header: 'Authorization: Bearer', token: 'test-token'},
      metadata: {
        uriConsentRequired: {
          authorizationUri: 'https://example.com/auth',
          consentNonce: 'sample-nonce',
        },
      },
    });

    const credential = await provider.getAuthCredential(
      AUTH_SCHEME,
      contextWithEvents(consentCompletedEvents('call-123')),
    );

    expect(credential?.http?.credentials.token).toBe('test-token');
  });

  it('throws when consent completed yet is still demanded', async () => {
    client.retrieveCredentials.mockResolvedValue({
      done: false,
      metadata: {
        uriConsentRequired: {
          authorizationUri: 'https://example.com/auth',
          consentNonce: 'sample-nonce',
        },
      },
    });

    await expect(
      provider.getAuthCredential(
        AUTH_SCHEME,
        contextWithEvents(consentCompletedEvents('call-123')),
      ),
    ).rejects.toThrow('Failed to retrieve consent based credential.');
  });

  it('resolves to undefined for an operation in no known state', async () => {
    client.retrieveCredentials.mockResolvedValue({done: false});

    await expect(
      provider.getAuthCredential(AUTH_SCHEME, CONTEXT),
    ).resolves.toBeUndefined();
  });

  it('builds a REST client when none is injected', () => {
    expect(() => new IamConnectorCredentialsProvider()).not.toThrow();
  });
});
