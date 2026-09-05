/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {RestIamConnectorCredentialsClient} from '../../../src/integrations/agent_identity/iam_connector_credentials_client.js';
import {CONNECTOR_NAME, bearerOperation} from './agent_identity_fixtures.js';

vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: () =>
      Promise.resolve({
        getRequestHeaders: () =>
          Promise.resolve(new Headers({authorization: 'Bearer fake-token'})),
      }),
  })),
}));

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
