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
  IamConnectorCredentialsProvider,
  RestIamConnectorCredentialsClient,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  CONNECTOR_NAME,
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

describe('RestIamConnectorCredentialsClient', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('sends the credentials of the caller as JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(bearerOperation()), {status: 200}),
    );
    const client = new RestIamConnectorCredentialsClient();

    const operation = await client.retrieveCredentials(CONNECTOR_NAME, {
      userId: 'user',
      forceRefresh: false,
    });

    expect(operation).toEqual(bearerOperation());
    const headers = fetchMock.mock.calls[0][1]?.headers;
    if (!(headers instanceof Headers)) {
      expect.fail('expected the client to send a Headers object');
    }
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('authorization')).toBe('Bearer fake-token');
  });

  it('reports the status and body of a failed request', async () => {
    fetchMock.mockResolvedValue(
      new Response('connector not found', {status: 404}),
    );
    const client = new RestIamConnectorCredentialsClient();

    await expect(
      client.retrieveCredentials(CONNECTOR_NAME, {
        userId: 'user',
        forceRefresh: false,
      }),
    ).rejects.toThrow(
      'IAM Connector Credentials request failed with status 404: ' +
        'connector not found',
    );
  });
});
