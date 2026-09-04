/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createHash} from 'node:crypto';
import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {version} from '../../version.js';
import type {ResolvedPubSubCredentials} from './pubsub_credentials.js';
import {
  loadPubSubSdk,
  PubSubPublisherClient,
  PubSubSdkOptions,
  PubSubSubscriberClient,
} from './sdk.js';

/**
 * Attribution sent to Pub/Sub, matching adk-python's
 * `USER_AGENT = f"adk-pubsub-tool google-adk/{version.__version__}"`. gax
 * composes the header from `libName/libVersion`.
 */
export const PUBSUB_USER_AGENT = 'adk-pubsub-tool google-adk';

/** How long a cached client is reused, matching adk-python's `_CACHE_TTL`. */
export const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * How many publisher clients the cache holds, matching adk-python's
 * `_CACHE_MAX_SIZE`.
 */
export const CACHE_MAX_SIZE = 10;

/** Which identity a client speaks as, and how it identifies itself. */
export interface PubSubClientRequest {
  credentials: ResolvedPubSubCredentials;
  projectId?: string;
  /**
   * Extra components identifying the call: the project id and the operation
   * name. They separate one operation's client from another's, as adk-python's
   * `user_agent` argument does.
   */
  userAgent?: string[];
}

/** A client the cache holds, and when it stops being reused. */
interface CacheEntry<T> {
  client: Promise<T>;
  expiresAt: number;
}

/** A cached client owns a gRPC channel, so it has to be closed. */
interface Closeable {
  close(): Promise<void>;
}

/**
 * The clients one credential has opened, reused until they expire.
 *
 * The promise is cached rather than the resolved client, so two concurrent
 * first calls open one channel instead of two.
 */
class ClientCache<T extends Closeable> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  /**
   * @param maxSize How many clients to hold. An unbounded cache evicts
   *   nothing, which is what adk-python's subscriber cache does.
   */
  constructor(private readonly maxSize?: number) {}

  /** How many clients the cache currently holds. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Returns the client cached under `key`, or builds and caches one.
   *
   * @param key Identifies the credential and the call the client serves.
   * @param create Builds the client when the cache has none to serve.
   * @return The cached or newly built client.
   */
  get(key: string, create: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      if (cached.expiresAt > now) {
        // Re-insertion moves the entry to the end, so the iteration order is
        // least-recently-used first.
        this.entries.delete(key);
        this.entries.set(key, cached);
        return cached.client;
      }
      this.entries.delete(key);
    }
    if (this.maxSize !== undefined && this.entries.size >= this.maxSize) {
      // The evicted client is dropped rather than closed, since another call
      // may still be using it.
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
    const client = create();
    this.entries.set(key, {client, expiresAt: now + CACHE_TTL_MS});
    return client;
  }

  /**
   * Closes every client this cache holds and empties it.
   *
   * One client that fails to close, or one that never finished being built,
   * must not keep the others open, so every outcome is settled first.
   */
  async close(): Promise<void> {
    const pending = [...this.entries.values()];
    this.entries.clear();
    const outcomes = await Promise.allSettled(
      pending.map((entry) => entry.client.then((client) => client.close())),
    );
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        logger.warn(
          `Closing a Pub/Sub client failed: ${formatError(outcome.reason)}`,
        );
      }
    }
  }
}

/**
 * The cache key for one request, standing in for adk-python's
 * `id(credentials)`.
 *
 * The credentials are hashed rather than used directly, because they carry a
 * private key or a refresh token and a cache key outlives the call. Two end
 * users therefore get their own client without their secrets sitting in a map
 * key that a heap dump would expose.
 */
function cacheKey(request: PubSubClientRequest): string {
  const identity = JSON.stringify([
    request.credentials,
    request.projectId ?? '',
    request.userAgent ?? [],
  ]);
  return createHash('sha256').update(identity).digest('hex');
}

/** The options every Pub/Sub client is built with. */
function clientOptions(request: PubSubClientRequest): PubSubSdkOptions {
  return {
    projectId: request.projectId,
    ...request.credentials,
    libName: PUBSUB_USER_AGENT,
    libVersion: version,
  };
}

const publisherCache = new ClientCache<PubSubPublisherClient>(CACHE_MAX_SIZE);
// Unbounded, matching adk-python, whose subscriber cache is a plain dict with
// a TTL while its publisher cache is a bounded `OrderedDict`.
const subscriberCache = new ClientCache<PubSubSubscriberClient>();

/**
 * Returns the publisher client for one credential, building it on first use.
 *
 * @param request Which identity to publish as.
 * @return The cached client.
 */
export function getPublisherClient(
  request: PubSubClientRequest,
): Promise<PubSubPublisherClient> {
  return publisherCache.get(cacheKey(request), async () => {
    const {v1} = await loadPubSubSdk();
    return new v1.PublisherClient(clientOptions(request));
  });
}

/**
 * Returns the subscriber client for one credential, building it on first use.
 *
 * @param request Which identity to pull as.
 * @return The cached client.
 */
export function getSubscriberClient(
  request: PubSubClientRequest,
): Promise<PubSubSubscriberClient> {
  return subscriberCache.get(cacheKey(request), async () => {
    const {v1} = await loadPubSubSdk();
    return new v1.SubscriberClient(clientOptions(request));
  });
}

/**
 * Closes every cached Pub/Sub client and empties both caches.
 *
 * Calling it twice is safe: the second call finds both caches empty.
 */
export async function cleanupClients(): Promise<void> {
  await Promise.all([publisherCache.close(), subscriberCache.close()]);
}

/** How many publisher clients the cache holds. Read by the tests. */
export function publisherCacheSize(): number {
  return publisherCache.size;
}
