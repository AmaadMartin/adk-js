/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `getGcsClient` only. `createGcsClient`, the factory `GcsToolset` calls, is
 * covered by `client_test.ts`: the two suites script a different stand-in for
 * `@google-cloud/storage`, and one file installs one `vi.mock`.
 */

/**
 * Ported from adk-python `main`,
 * `tests/unittests/integrations/gcs/test_client.py`.
 *
 * The reference patches `storage.Client` and inspects the call. This port
 * patches `@google-cloud/storage` for the same reason: the literal import
 * specifier inside `client.ts` is what lets `vi.mock` intercept it.
 */

// Not part of the package barrel: the toolset is the public surface, and
// it is what calls these.
import {OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  GCS_USER_AGENT,
  getGcsClient,
} from '../../../src/integrations/gcs/client.js';

import {FakeStorage, resetGcsFakes, storageInstances} from './gcs_fakes.js';

vi.mock('@google-cloud/storage', async () => ({
  Storage: (await import('./gcs_fakes.js')).FakeStorage,
}));

/** An OAuth2 client holding one access token, as a tool call resolves. */
function credentialsWithToken(token: string): OAuth2Client {
  const client = new OAuth2Client();
  client.setCredentials({access_token: token});
  return client;
}

describe('getGcsClient', () => {
  beforeEach(() => {
    resetGcsFakes();
  });

  it('test_get_gcs_client', async () => {
    const credentials = credentialsWithToken('test-token');

    const storage = await getGcsClient({
      project: 'test-project',
      credentials,
    });

    expect(storage).toBeInstanceOf(FakeStorage);
    expect(storageInstances).toHaveLength(1);
    const {authClient, ...rest} = storageInstances[0].options;
    expect(rest).toEqual({
      projectId: 'test-project',
      userAgent: GCS_USER_AGENT,
    });
    // The client is handed over through `asStorageAuthClient`, so it is the
    // adapter rather than the credential itself. It must still answer for
    // that credential, and with a plain object: `storage_auth_test.ts` shows
    // what a `Headers` here costs.
    expect(authClient).not.toBe(credentials);
    expect(await authClient?.getRequestHeaders()).toEqual({
      authorization: 'Bearer test-token',
    });
  });

  it('test_get_gcs_client_is_never_shared_between_credentials', async () => {
    for (let i = 0; i < 200; i++) {
      const credentials = credentialsWithToken(`token-${i}`);

      await getGcsClient({credentials});

      expect(
        await storageInstances[i].options.authClient?.getRequestHeaders(),
      ).toEqual({authorization: `Bearer token-${i}`});
    }
    expect(storageInstances).toHaveLength(200);
  });

  it('test_get_gcs_client_returns_a_new_client_per_call', async () => {
    const credentials = credentialsWithToken('test-token');

    const first = await getGcsClient({project: 'test-project', credentials});
    const second = await getGcsClient({project: 'test-project', credentials});

    expect(first).not.toBe(second);
    expect(storageInstances).toHaveLength(2);
  });
});
