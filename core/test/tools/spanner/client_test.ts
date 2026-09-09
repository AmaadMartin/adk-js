/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  createTokenAuthClient,
  withSpannerAdminClients,
} from '../../../src/tools/spanner/client.js';
import {
  DatabaseAdminClientMock,
  fakeDatabaseAdmin,
  fakeInstanceAdmin,
  InstanceAdminClientMock,
  resetSpannerFakes,
  testAuthClient,
} from './spanner_test_utils.js';

vi.mock('@google-cloud/spanner-api', async () => {
  const {fakeSpannerModule} = await import('./spanner_test_utils.js');
  return fakeSpannerModule;
});

const LIB_NAME = 'adk-spanner-tool google-adk';

describe('withSpannerAdminClients', () => {
  beforeEach(() => {
    resetSpannerFakes();
  });

  it('builds both clients with the auth client and the ADK attribution', async () => {
    const authClient = testAuthClient();

    const clients = await withSpannerAdminClients(
      authClient,
      async (built) => built,
    );

    const expected = {authClient, libName: LIB_NAME, libVersion: version};
    expect(InstanceAdminClientMock).toHaveBeenCalledWith(expected);
    expect(DatabaseAdminClientMock).toHaveBeenCalledWith(expected);
    expect(clients.instanceAdmin).toBe(fakeInstanceAdmin);
    expect(clients.databaseAdmin).toBe(fakeDatabaseAdmin);
  });

  it('returns what the callback returns', async () => {
    const result = await withSpannerAdminClients(
      testAuthClient(),
      async () => 'done',
    );

    expect(result).toBe('done');
  });

  it('closes both clients when the callback resolves', async () => {
    await withSpannerAdminClients(testAuthClient(), async () => undefined);

    expect(fakeInstanceAdmin.close).toHaveBeenCalledTimes(1);
    expect(fakeDatabaseAdmin.close).toHaveBeenCalledTimes(1);
  });

  it('closes both clients when the callback throws', async () => {
    const promise = withSpannerAdminClients(testAuthClient(), async () => {
      throw new Error('call failed');
    });

    await expect(promise).rejects.toThrow('call failed');
    expect(fakeInstanceAdmin.close).toHaveBeenCalledTimes(1);
    expect(fakeDatabaseAdmin.close).toHaveBeenCalledTimes(1);
  });
});

describe('createTokenAuthClient', () => {
  it('carries the access token', async () => {
    const client = await createTokenAuthClient({accessToken: 'test-token'});

    expect(client.credentials.access_token).toBe('test-token');
  });

  it('carries the refresh token and the expiry', async () => {
    const client = await createTokenAuthClient({
      accessToken: 'test-token',
      refreshToken: 'refresh',
      expiresAt: 1_700_000_000_000,
    });

    expect(client.credentials.refresh_token).toBe('refresh');
    expect(client.credentials.expiry_date).toBe(1_700_000_000_000);
  });

  it('renews against the OAuth client it is given', async () => {
    const client = await createTokenAuthClient(
      {accessToken: 'test-token'},
      {clientId: 'client-id', clientSecret: 'client-secret'},
    );

    expect(client.generateAuthUrl({scope: 'https://example.test/s'})).toContain(
      'client_id=client-id',
    );
  });
});
