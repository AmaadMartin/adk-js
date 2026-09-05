/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`,
 * `tests/unittests/integrations/gcs/test_client.py`.
 *
 * The reference patches `storage.Client` and inspects the call. This port
 * patches `@google-cloud/storage` for the same reason: the literal import
 * specifier inside `client.ts` is what lets `vi.mock` intercept it.
 */

import {GCS_USER_AGENT, getGcsClient} from '@google/adk';
import {OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';

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
    expect(storageInstances[0].options).toEqual({
      projectId: 'test-project',
      authClient: credentials,
      userAgent: GCS_USER_AGENT,
    });
  });

  it('test_get_gcs_client_is_never_shared_between_credentials', async () => {
    for (let i = 0; i < 200; i++) {
      const credentials = credentialsWithToken(`token-${i}`);

      await getGcsClient({credentials});

      expect(storageInstances[i].options.authClient).toBe(credentials);
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
