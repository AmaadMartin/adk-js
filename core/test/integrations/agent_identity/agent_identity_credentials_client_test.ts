/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {RestAgentIdentityCredentialsClient} from '../../../src/integrations/agent_identity/agent_identity_credentials_client.js';
import {AUTH_PROVIDER_NAME, bearerSuccess} from './agent_identity_fixtures.js';

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: () =>
      Promise.resolve({
        getRequestHeaders: () =>
          Promise.resolve(new Headers({authorization: 'Bearer fake-token'})),
      }),
  })),
}));

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
