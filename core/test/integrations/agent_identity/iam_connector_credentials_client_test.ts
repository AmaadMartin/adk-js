/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  RestIamConnectorCredentialsClient,
  TARGET_HOST_ENV_VAR,
} from '../../../src/integrations/agent_identity/iam_connector_credentials_client.js';

const {googleAuthConstructor} = vi.hoisted(() => ({
  googleAuthConstructor: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => {
    googleAuthConstructor();
    return {
      getClient: vi.fn().mockResolvedValue({
        getRequestHeaders: vi
          .fn()
          .mockResolvedValue({'Authorization': 'Bearer fake-token'}),
        credentials: {},
      }),
    };
  }),
}));

const CONNECTOR_NAME =
  'projects/test-project/locations/global/connectors/test-connector';

describe('RestIamConnectorCredentialsClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        done: true,
        response: {header: 'Authorization: Bearer', token: 'test-token'},
      }),
    });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not build the transport until the first request', () => {
    new RestIamConnectorCredentialsClient();

    expect(googleAuthConstructor).not.toHaveBeenCalled();
  });

  it('posts to the default host and parses the operation', async () => {
    const client = new RestIamConnectorCredentialsClient();

    const operation = await client.retrieveCredentials(CONNECTOR_NAME, {
      userId: 'user',
      scopes: ['test-scope'],
      continueUri: 'https://example.com/continue',
      forceRefresh: false,
    });

    expect(operation.response?.token).toBe('test-token');
    expect(fetchMock).toHaveBeenCalledWith(
      `https://iamconnectorcredentials.googleapis.com/v1alpha/${CONNECTOR_NAME}/credentials:retrieve`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Authorization': 'Bearer fake-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          userId: 'user',
          scopes: ['test-scope'],
          continueUri: 'https://example.com/continue',
          forceRefresh: false,
        }),
      }),
    );
  });

  it('reuses the transport across requests', async () => {
    const client = new RestIamConnectorCredentialsClient();

    await client.retrieveCredentials(CONNECTOR_NAME, {userId: 'user'});
    await client.retrieveCredentials(CONNECTOR_NAME, {userId: 'user'});

    expect(googleAuthConstructor).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours the target host override', async () => {
    vi.stubEnv(TARGET_HOST_ENV_VAR, 'some-host');
    const client = new RestIamConnectorCredentialsClient();

    await client.retrieveCredentials(CONNECTOR_NAME, {userId: 'user'});

    expect(fetchMock).toHaveBeenCalledWith(
      `https://some-host/v1alpha/${CONNECTOR_NAME}/credentials:retrieve`,
      expect.any(Object),
    );
  });

  it('reports a failed request without echoing the body', async () => {
    const body = 'token=super-secret';
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue(body),
    });
    const client = new RestIamConnectorCredentialsClient();

    await expect(
      client.retrieveCredentials(CONNECTOR_NAME, {userId: 'user'}),
    ).rejects.toThrow('Credentials request failed with status 503.');
  });
});
