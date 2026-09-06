/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/eventarc/test_client.py`, read at `a3bd1115`
 * on `main`. Each ported `it` keeps its Python name.
 */

import {
  cleanupClients,
  type AuthorizedUserCredentials,
  type EventarcCredentialsConfig,
  type ServiceAccountCredentials,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  getPublisherClient,
  publisherCacheKey,
  removePublisherClient,
} from '../../../src/integrations/eventarc/client.js';
import {builtClients, resetEventarcFake} from './eventarc_test_utils.js';

vi.mock('@google-cloud/eventarc-publishing', async () => {
  const {FakePublisherClient} = await import('./eventarc_test_utils.js');
  return {PublisherClient: FakePublisherClient};
});

/** Matches `_CACHE_MAX_SIZE` in the client module. */
const CACHE_MAX_SIZE = 10;

const USER_CREDENTIAL_BODY: AuthorizedUserCredentials = {
  type: 'authorized_user',
  client_id: 'client1',
  client_secret: 'secret1',
  refresh_token: 'refresh1',
};

const SERVICE_ACCOUNT_BODY: ServiceAccountCredentials = {
  client_email: 'test@test.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nkey1\n-----END PRIVATE KEY-----',
};

const USER_CREDENTIALS: EventarcCredentialsConfig = {
  credentials: USER_CREDENTIAL_BODY,
};

const SERVICE_ACCOUNT_CREDENTIALS: EventarcCredentialsConfig = {
  credentials: SERVICE_ACCOUNT_BODY,
};

describe('publisher client cache', () => {
  beforeEach(async () => {
    await cleanupClients();
    resetEventarcFake();
  });

  afterEach(async () => {
    await cleanupClients();
  });

  it('test_get_publisher_client_cache', async () => {
    const c1 = await getPublisherClient({projectId: 'p1'});
    expect(builtClients).toHaveLength(1);

    const c2 = await getPublisherClient({projectId: 'p1'});
    expect(builtClients).toHaveLength(1);
    expect(c2).toBe(c1);

    const c3 = await getPublisherClient({projectId: 'p2'});
    expect(builtClients).toHaveLength(2);
    expect(c3).not.toBe(c1);
  });

  it('test_remove_publisher_client', async () => {
    await getPublisherClient({projectId: 'p1'});
    expect(builtClients).toHaveLength(1);

    await removePublisherClient({projectId: 'p1'});
    expect(builtClients[0].closeCount).toBe(1);

    // Removing a client that is no longer cached is safe.
    await removePublisherClient({projectId: 'p1'});
    expect(builtClients[0].closeCount).toBe(1);

    // The next request builds a fresh client.
    await getPublisherClient({projectId: 'p1'});
    expect(builtClients).toHaveLength(2);
  });

  it('test_publisher_client_cache_lru_eviction', async () => {
    for (let i = 0; i < CACHE_MAX_SIZE; i++) {
      await getPublisherClient({projectId: `project-${i}`});
    }
    expect(builtClients).toHaveLength(CACHE_MAX_SIZE);

    // Touch project-0 so that project-1 becomes the oldest entry.
    await getPublisherClient({projectId: 'project-0'});
    expect(builtClients).toHaveLength(CACHE_MAX_SIZE);

    await getPublisherClient({projectId: `project-${CACHE_MAX_SIZE}`});
    expect(builtClients).toHaveLength(CACHE_MAX_SIZE + 1);
    expect(builtClients[1].closeCount).toBe(1);

    // project-1 was evicted, so it is rebuilt.
    await getPublisherClient({projectId: 'project-1'});
    expect(builtClients).toHaveLength(CACHE_MAX_SIZE + 2);

    // project-0 is still cached.
    await getPublisherClient({projectId: 'project-0'});
    expect(builtClients).toHaveLength(CACHE_MAX_SIZE + 2);
    expect(builtClients[0].closeCount).toBe(0);
  });

  it('test_get_publisher_client_cache_user_credentials', async () => {
    const c1 = await getPublisherClient({
      credentialsConfig: USER_CREDENTIALS,
      projectId: 'p1',
    });
    expect(builtClients).toHaveLength(1);

    const c2 = await getPublisherClient({
      credentialsConfig: {credentials: {...USER_CREDENTIAL_BODY}},
      projectId: 'p1',
    });

    expect(builtClients).toHaveLength(1);
    expect(c2).toBe(c1);
  });

  it('test_get_publisher_client_cache_external_account', async () => {
    const c1 = await getPublisherClient({
      credentialsConfig: SERVICE_ACCOUNT_CREDENTIALS,
      projectId: 'p1',
    });
    expect(builtClients).toHaveLength(1);

    const c2 = await getPublisherClient({
      credentialsConfig: {
        credentials: {...SERVICE_ACCOUNT_BODY},
      },
      projectId: 'p1',
    });

    expect(builtClients).toHaveLength(1);
    expect(c2).toBe(c1);
  });

  it('gives one client to two callers that race for it', async () => {
    const [c1, c2] = await Promise.all([
      getPublisherClient({projectId: 'p1'}),
      getPublisherClient({projectId: 'p1'}),
    ]);

    expect(builtClients).toHaveLength(1);
    expect(c2).toBe(c1);
  });

  it('rebuilds a client once its entry has expired', async () => {
    vi.useFakeTimers();
    try {
      await getPublisherClient({projectId: 'p1'});
      vi.advanceTimersByTime(30 * 60 * 1000 + 1);
      await getPublisherClient({projectId: 'p1'});
    } finally {
      vi.useRealTimers();
    }

    expect(builtClients).toHaveLength(2);
    expect(builtClients[0].closeCount).toBe(1);
  });

  it('passes the credentials and the project through to the client', async () => {
    await getPublisherClient({
      credentialsConfig: {
        ...SERVICE_ACCOUNT_CREDENTIALS,
        keyFilename: '/tmp/key.json',
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
      projectId: 'p1',
    });

    const options = builtClients[0].options;
    expect(options?.projectId).toBe('p1');
    expect(options?.credentials).toEqual(SERVICE_ACCOUNT_BODY);
    expect(options?.keyFilename).toBe('/tmp/key.json');
    expect(options?.scopes).toEqual([
      'https://www.googleapis.com/auth/cloud-platform',
    ]);
    expect(options?.libName).toBe('adk-eventarc-tool');
  });

  it('reports a failure to close rather than raising it', async () => {
    await getPublisherClient({projectId: 'p1'});
    vi.spyOn(builtClients[0], 'close').mockRejectedValueOnce(
      new Error('channel already gone'),
    );

    await expect(
      removePublisherClient({projectId: 'p1'}),
    ).resolves.toBeUndefined();
  });

  it('closes every cached client on cleanup', async () => {
    await getPublisherClient({projectId: 'p1'});
    await getPublisherClient({projectId: 'p2'});

    await cleanupClients();

    expect(builtClients.map((client) => client.closeCount)).toEqual([1, 1]);
    await getPublisherClient({projectId: 'p1'});
    expect(builtClients).toHaveLength(3);
  });
});

describe('publisherCacheKey', () => {
  it('is equal for two structurally equal requests', () => {
    expect(
      publisherCacheKey({
        credentialsConfig: USER_CREDENTIALS,
        projectId: 'p1',
      }),
    ).toBe(
      publisherCacheKey({
        credentialsConfig: {credentials: {...USER_CREDENTIAL_BODY}},
        projectId: 'p1',
      }),
    );
  });

  it('ignores the order the credential fields were written in', () => {
    expect(
      publisherCacheKey({
        credentialsConfig: {
          credentials: {
            client_email: 'test@test.com',
            private_key: 'key1',
          },
        },
      }),
    ).toBe(
      publisherCacheKey({
        credentialsConfig: {
          credentials: {
            private_key: 'key1',
            client_email: 'test@test.com',
          },
        },
      }),
    );
  });

  it.each([
    {
      name: 'projectId',
      request: {credentialsConfig: USER_CREDENTIALS, projectId: 'p2'},
    },
    {
      name: 'refresh_token',
      request: {
        credentialsConfig: {
          credentials: {...USER_CREDENTIAL_BODY, refresh_token: 'r2'},
        },
        projectId: 'p1',
      },
    },
    {
      name: 'keyFilename',
      request: {
        credentialsConfig: {...USER_CREDENTIALS, keyFilename: '/tmp/key.json'},
        projectId: 'p1',
      },
    },
    {
      name: 'scopes',
      request: {
        credentialsConfig: {...USER_CREDENTIALS, scopes: ['scope-a']},
        projectId: 'p1',
      },
    },
    {name: 'no credentials at all', request: {projectId: 'p1'}},
  ])('differs when the $name differs', ({request}) => {
    expect(publisherCacheKey(request)).not.toBe(
      publisherCacheKey({
        credentialsConfig: USER_CREDENTIALS,
        projectId: 'p1',
      }),
    );
  });

  it('keeps the secret out of the key', () => {
    const key = publisherCacheKey({
      credentialsConfig: {
        credentials: {
          type: 'authorized_user',
          client_id: 'client1',
          client_secret: 'topsecret',
          refresh_token: 'alsosecret',
        },
        keyFilename: '/tmp/key.json',
      },
      projectId: 'p1',
    });

    expect(key).not.toContain('topsecret');
    expect(key).not.toContain('alsosecret');
    expect(key).not.toContain('client1');
  });
});
