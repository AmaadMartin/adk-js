/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  RestAgentIdentityCredentialsClient,
  TARGET_HOST_ENV_VAR,
} from '../../../src/integrations/agent_identity/agent_identity_credentials_client.js';

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

const PROVIDER_NAME =
  'projects/test-project/locations/global/authProviders/test-provider';

describe('RestAgentIdentityCredentialsClient', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        success: {header: 'Authorization: Bearer', token: 'test-token'},
      }),
    });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not build the transport until the first request', () => {
    new RestAgentIdentityCredentialsClient();

    expect(googleAuthConstructor).not.toHaveBeenCalled();
  });

  it('posts to the default host and parses the response', async () => {
    const client = new RestAgentIdentityCredentialsClient();

    const response = await client.retrieveCredentials(PROVIDER_NAME, {
      userId: 'user',
      scopes: ['test-scope'],
      continueUri: 'https://example.com/continue',
    });

    expect(response.success?.token).toBe('test-token');
    expect(fetchMock).toHaveBeenCalledWith(
      `https://agentidentitycredentials.googleapis.com/v1/${PROVIDER_NAME}/credentials:retrieve`,
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
        }),
      }),
    );
  });

  it('reuses the transport across requests', async () => {
    const client = new RestAgentIdentityCredentialsClient();

    await client.retrieveCredentials(PROVIDER_NAME, {userId: 'user'});
    await client.retrieveCredentials(PROVIDER_NAME, {userId: 'user'});

    expect(googleAuthConstructor).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honours the target host override', async () => {
    vi.stubEnv(TARGET_HOST_ENV_VAR, 'some-host');
    const client = new RestAgentIdentityCredentialsClient();

    await client.retrieveCredentials(PROVIDER_NAME, {userId: 'user'});

    expect(fetchMock).toHaveBeenCalledWith(
      `https://some-host/v1/${PROVIDER_NAME}/credentials:retrieve`,
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
    const client = new RestAgentIdentityCredentialsClient();

    await expect(
      client.retrieveCredentials(PROVIDER_NAME, {userId: 'user'}),
    ).rejects.toThrow('Credentials request failed with status 503.');
  });
});
