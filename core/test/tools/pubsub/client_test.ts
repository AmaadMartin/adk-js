/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports adk-python `tests/unittests/tools/pubsub/test_pubsub_client.py`.
 * The `it` titles of the ported cases keep the Python test names so the two
 * suites stay greppable.
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
// The client cache is internal to the module, so it is imported from source.
import {
  CACHE_MAX_SIZE,
  CACHE_TTL_MS,
  cleanupClients,
  getPublisherClient,
  getSubscriberClient,
  PUBSUB_USER_AGENT,
} from '../../../src/tools/pubsub/client.js';
import {logger} from '../../../src/utils/logger.js';
import {version} from '../../../src/version.js';
import {
  pubsubFake,
  testResolvedCredentials,
  testServiceAccount,
} from './pubsub_test_utils.js';

vi.mock('@google-cloud/pubsub', async () => {
  const {fakePubSubModule} = await import('./pubsub_test_utils.js');
  return fakePubSubModule;
});

let nextIdentity = 0;

/** Credentials for an end user no other call in this file uses. */
function someone() {
  nextIdentity += 1;
  return testResolvedCredentials(`user-${nextIdentity}`);
}

beforeEach(() => {
  pubsubFake.reset();
});

afterEach(async () => {
  await cleanupClients();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the cache bounds', () => {
  // The bounded-cache tests below read these constants, so they prove the
  // mechanism and not the values. adk-python fixes both, and a cache that
  // grows without bound is the failure they prevent.
  it('match adk-python _CACHE_MAX_SIZE and _CACHE_TTL', () => {
    expect(CACHE_MAX_SIZE).toBe(10);
    expect(CACHE_TTL_MS).toBe(1800 * 1000);
  });

  it('reports the ADK attribution adk-python sends', () => {
    expect(PUBSUB_USER_AGENT).toBe('adk-pubsub-tool google-adk');
  });
});

describe('getPublisherClient', () => {
  it('test_get_publisher_client', async () => {
    await getPublisherClient({credentials: testResolvedCredentials('agent')});

    expect(pubsubFake.publisherOptions).toEqual([
      {
        projectId: undefined,
        credentials: testServiceAccount('agent'),
        scopes: ['https://www.googleapis.com/auth/pubsub'],
        libName: PUBSUB_USER_AGENT,
        libVersion: version,
      },
    ]);
  });

  it('test_get_publisher_client_with_options', async () => {
    await getPublisherClient({credentials: someone(), projectId: 'my-project'});

    expect(pubsubFake.publisherOptions[0]['projectId']).toBe('my-project');
  });

  it('test_get_publisher_client_caching', async () => {
    const credentials = someone();

    const first = await getPublisherClient({credentials});
    const second = await getPublisherClient({credentials});
    const other = await getPublisherClient({credentials: someone()});

    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(pubsubFake.publisherOptions).toHaveLength(2);
  });

  it('test_get_publisher_client_caching_equivalent_options', async () => {
    // A fresh options object per call, as the tools build one per message.
    const request = () =>
      getPublisherClient({
        credentials: testResolvedCredentials('agent'),
        projectId: 'my-project',
      });

    const first = await request();
    const second = await request();
    const third = await request();

    expect(pubsubFake.publisherOptions).toHaveLength(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('test_get_publisher_client_caching_different_options', async () => {
    const credentials = someone();

    const orders = await getPublisherClient({credentials, projectId: 'orders'});
    const events = await getPublisherClient({credentials, projectId: 'events'});

    expect(events).not.toBe(orders);
    expect(pubsubFake.publisherOptions).toHaveLength(2);
  });

  it('test_get_publisher_client_cache_is_bounded', async () => {
    const users = Array.from({length: CACHE_MAX_SIZE}, someone);
    for (const credentials of users) {
      await getPublisherClient({credentials});
    }

    // Every one of them is still cached, so the cache holds at least
    // CACHE_MAX_SIZE clients.
    for (const credentials of users) {
      await getPublisherClient({credentials});
    }
    expect(pubsubFake.publisherOptions).toHaveLength(CACHE_MAX_SIZE);

    // One more evicts the oldest, so it holds no more than CACHE_MAX_SIZE.
    await getPublisherClient({credentials: someone()});
    await getPublisherClient({credentials: users[0]});
    expect(pubsubFake.publisherOptions).toHaveLength(CACHE_MAX_SIZE + 2);
  });

  it('test_get_publisher_client_cache_evicts_least_recently_used', async () => {
    const users = Array.from({length: CACHE_MAX_SIZE}, someone);
    for (const credentials of users) {
      await getPublisherClient({credentials});
    }

    // Re-touch the oldest entry, then overflow the cache by one.
    const oldest = await getPublisherClient({credentials: users[0]});
    await getPublisherClient({credentials: someone()});
    const built = pubsubFake.publisherOptions.length;

    // The re-touched entry survived, and the one after it was evicted.
    expect(await getPublisherClient({credentials: users[0]})).toBe(oldest);
    expect(pubsubFake.publisherOptions).toHaveLength(built);
    await getPublisherClient({credentials: users[1]});
    expect(pubsubFake.publisherOptions).toHaveLength(built + 1);
  });

  it('keeps two end users on their own client', async () => {
    const alice = await getPublisherClient({
      credentials: testResolvedCredentials('alice'),
    });
    const bob = await getPublisherClient({
      credentials: testResolvedCredentials('bob'),
    });

    expect(bob).not.toBe(alice);
  });
});

describe('getSubscriberClient', () => {
  it('test_get_subscriber_client', async () => {
    await getSubscriberClient({credentials: testResolvedCredentials('agent')});

    expect(pubsubFake.subscriberOptions).toEqual([
      {
        projectId: undefined,
        credentials: testServiceAccount('agent'),
        scopes: ['https://www.googleapis.com/auth/pubsub'],
        libName: PUBSUB_USER_AGENT,
        libVersion: version,
      },
    ]);
  });

  it('test_get_subscriber_client_caching', async () => {
    const credentials = someone();

    const first = await getSubscriberClient({credentials});
    const second = await getSubscriberClient({credentials});
    const other = await getSubscriberClient({credentials: someone()});

    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(pubsubFake.subscriberOptions).toHaveLength(2);
  });

  it('holds more clients than the bounded publisher cache', async () => {
    for (let call = 0; call < CACHE_MAX_SIZE + 5; call++) {
      await getSubscriberClient({credentials: someone()});
    }
    const credentials = someone();
    const first = await getSubscriberClient({credentials});

    expect(await getSubscriberClient({credentials})).toBe(first);
  });
});

describe('beyond the adk-python suite', () => {
  it('rebuilds a client whose entry has expired', async () => {
    vi.useFakeTimers();
    const credentials = someone();
    const first = await getPublisherClient({credentials});

    vi.setSystemTime(Date.now() + CACHE_TTL_MS + 1);
    const second = await getPublisherClient({credentials});

    expect(second).not.toBe(first);
    expect(pubsubFake.publisherOptions).toHaveLength(2);
  });

  it('reuses a client that has not expired yet', async () => {
    vi.useFakeTimers();
    const credentials = someone();
    const first = await getPublisherClient({credentials});

    vi.setSystemTime(Date.now() + CACHE_TTL_MS - 1);

    expect(await getPublisherClient({credentials})).toBe(first);
  });

  it('opens one client when two calls race for it', async () => {
    const credentials = someone();

    const [first, second] = await Promise.all([
      getPublisherClient({credentials}),
      getPublisherClient({credentials}),
    ]);

    expect(second).toBe(first);
    expect(pubsubFake.publisherOptions).toHaveLength(1);
  });

  it('closes every cached client and empties both caches', async () => {
    const publishing = someone();
    const pulling = someone();
    await getPublisherClient({credentials: publishing});
    await getSubscriberClient({credentials: pulling});

    await cleanupClients();

    expect(pubsubFake.closedPublishers).toBe(1);
    expect(pubsubFake.closedSubscribers).toBe(1);
    // The caches are empty, so the same credentials build fresh clients.
    await getPublisherClient({credentials: publishing});
    await getSubscriberClient({credentials: pulling});
    expect(pubsubFake.publisherOptions).toHaveLength(2);
    expect(pubsubFake.subscriberOptions).toHaveLength(2);
  });

  it('is a no-op when called a second time', async () => {
    await getPublisherClient({credentials: someone()});

    await cleanupClients();
    await cleanupClients();

    expect(pubsubFake.closedPublishers).toBe(1);
  });

  it('closes the remaining clients when one of them fails to close', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    await getPublisherClient({credentials: someone()});
    await getSubscriberClient({credentials: someone()});
    pubsubFake.failures.closePublisher = new Error('channel is wedged');

    await cleanupClients();

    expect(pubsubFake.closedSubscribers).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      'Closing a Pub/Sub client failed: channel is wedged',
    );
  });
});
