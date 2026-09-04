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
import {logger} from '../../../src/utils/logger.js';
import {version} from '../../../src/version.js';
// The client cache is internal to the module, so it is imported from source.
import {
  CACHE_MAX_SIZE,
  CACHE_TTL_MS,
  cleanupClients,
  getPublisherClient,
  getSubscriberClient,
  publisherCacheSize,
  PUBSUB_USER_AGENT,
} from '../../../src/tools/pubsub/client.js';
import {pubsubFake, testAuthClient} from './pubsub_test_utils.js';

vi.mock('@google-cloud/pubsub', async () => {
  const {fakePubSubModule} = await import('./pubsub_test_utils.js');
  return fakePubSubModule;
});

beforeEach(() => {
  pubsubFake.reset();
});

afterEach(async () => {
  await cleanupClients();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('getPublisherClient', () => {
  it('test_get_publisher_client', async () => {
    const authClient = testAuthClient();

    await getPublisherClient({authClient});

    expect(pubsubFake.publisherOptions).toEqual([
      {
        projectId: undefined,
        authClient,
        libName: PUBSUB_USER_AGENT,
        libVersion: version,
      },
    ]);
  });

  it('test_get_publisher_client_with_options', async () => {
    const authClient = testAuthClient();

    await getPublisherClient({
      authClient,
      projectId: 'my-project',
      userAgent: ['my-project', 'publish_message'],
    });

    expect(pubsubFake.publisherOptions[0]['projectId']).toBe('my-project');
  });

  it('test_get_publisher_client_caching', async () => {
    const authClient = testAuthClient();

    const first = await getPublisherClient({authClient});
    const second = await getPublisherClient({authClient});
    const other = await getPublisherClient({authClient: testAuthClient()});

    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(pubsubFake.publisherOptions).toHaveLength(2);
  });

  it('test_get_publisher_client_caching_equivalent_options', async () => {
    const authClient = testAuthClient();

    // A fresh options object per call, as the tools build one per message.
    const request = () =>
      getPublisherClient({
        authClient,
        projectId: 'my-project',
        userAgent: ['my-project', 'publish_message'],
      });

    const first = await request();
    const second = await request();
    const third = await request();

    expect(pubsubFake.publisherOptions).toHaveLength(1);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('test_get_publisher_client_caching_different_options', async () => {
    const authClient = testAuthClient();

    const publishing = await getPublisherClient({
      authClient,
      userAgent: ['publish_message'],
    });
    const pulling = await getPublisherClient({
      authClient,
      userAgent: ['pull_messages'],
    });

    expect(pulling).not.toBe(publishing);
    expect(pubsubFake.publisherOptions).toHaveLength(2);
  });

  it('test_get_publisher_client_cache_is_bounded', async () => {
    const total = CACHE_MAX_SIZE + 5;

    for (let call = 0; call < total; call++) {
      await getPublisherClient({authClient: testAuthClient()});
    }

    expect(pubsubFake.publisherOptions).toHaveLength(total);
    expect(publisherCacheSize()).toBe(CACHE_MAX_SIZE);
  });

  it('test_get_publisher_client_cache_evicts_least_recently_used', async () => {
    const authClients = Array.from({length: CACHE_MAX_SIZE}, testAuthClient);
    for (const authClient of authClients) {
      await getPublisherClient({authClient});
    }

    // Re-touch the oldest entry, then overflow the cache by one.
    const oldest = await getPublisherClient({authClient: authClients[0]});
    await getPublisherClient({authClient: testAuthClient()});
    const built = pubsubFake.publisherOptions.length;

    // The re-touched entry survived, and the one after it was evicted.
    expect(await getPublisherClient({authClient: authClients[0]})).toBe(oldest);
    expect(pubsubFake.publisherOptions).toHaveLength(built);
    await getPublisherClient({authClient: authClients[1]});
    expect(pubsubFake.publisherOptions).toHaveLength(built + 1);
  });
});

describe('getSubscriberClient', () => {
  it('test_get_subscriber_client', async () => {
    const authClient = testAuthClient();

    await getSubscriberClient({authClient});

    expect(pubsubFake.subscriberOptions).toEqual([
      {
        projectId: undefined,
        authClient,
        libName: PUBSUB_USER_AGENT,
        libVersion: version,
      },
    ]);
  });

  it('test_get_subscriber_client_caching', async () => {
    const authClient = testAuthClient();

    const first = await getSubscriberClient({authClient});
    const second = await getSubscriberClient({authClient});
    const other = await getSubscriberClient({authClient: testAuthClient()});

    expect(second).toBe(first);
    expect(other).not.toBe(first);
    expect(pubsubFake.subscriberOptions).toHaveLength(2);
  });

  it('holds more clients than the bounded publisher cache', async () => {
    for (let call = 0; call < CACHE_MAX_SIZE + 5; call++) {
      await getSubscriberClient({authClient: testAuthClient()});
    }
    const authClient = testAuthClient();
    const first = await getSubscriberClient({authClient});

    expect(await getSubscriberClient({authClient})).toBe(first);
  });
});

describe('beyond the adk-python suite', () => {
  it('rebuilds a client whose entry has expired', async () => {
    vi.useFakeTimers();
    const authClient = testAuthClient();
    const first = await getPublisherClient({authClient});

    vi.setSystemTime(Date.now() + CACHE_TTL_MS + 1);
    const second = await getPublisherClient({authClient});

    expect(second).not.toBe(first);
    expect(pubsubFake.publisherOptions).toHaveLength(2);
  });

  it('reuses a client that has not expired yet', async () => {
    vi.useFakeTimers();
    const authClient = testAuthClient();
    const first = await getPublisherClient({authClient});

    vi.setSystemTime(Date.now() + CACHE_TTL_MS - 1);

    expect(await getPublisherClient({authClient})).toBe(first);
  });

  it('opens one client when two calls race for it', async () => {
    const authClient = testAuthClient();

    const [first, second] = await Promise.all([
      getPublisherClient({authClient}),
      getPublisherClient({authClient}),
    ]);

    expect(second).toBe(first);
    expect(pubsubFake.publisherOptions).toHaveLength(1);
  });

  it('closes every cached client and empties both caches', async () => {
    await getPublisherClient({authClient: testAuthClient()});
    await getSubscriberClient({authClient: testAuthClient()});

    await cleanupClients();

    expect(pubsubFake.closedPublishers).toBe(1);
    expect(pubsubFake.closedSubscribers).toBe(1);
    expect(publisherCacheSize()).toBe(0);
  });

  it('is a no-op when called a second time', async () => {
    await getPublisherClient({authClient: testAuthClient()});

    await cleanupClients();
    await cleanupClients();

    expect(pubsubFake.closedPublishers).toBe(1);
  });

  it('closes the remaining clients when one of them fails to close', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
    await getPublisherClient({authClient: testAuthClient()});
    await getSubscriberClient({authClient: testAuthClient()});
    pubsubFake.failures.closePublisher = new Error('channel is wedged');

    await cleanupClients();

    expect(pubsubFake.closedSubscribers).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      'Closing a Pub/Sub client failed: channel is wedged',
    );
  });
});
