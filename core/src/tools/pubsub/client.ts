/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ClientConfig, PubSub, v1} from '@google-cloud/pubsub';
import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {version} from '../../version.js';

/** The package and the feature named when the peer is not installed. */
const PUBSUB_PEER = {
  packageName: '@google-cloud/pubsub',
  feature: 'PubSubToolset',
};

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

/** The synchronous pull and acknowledge client. */
export type SubscriberClient = InstanceType<typeof v1.SubscriberClient>;

/**
 * An auth client the Pub/Sub clients accept. Read off the SDK's own options
 * rather than imported from `google-auth-library`, because
 * `@google-cloud/pubsub` types this field with the copy of that package
 * `google-gax` pins.
 */
export type PubSubAuthClient = NonNullable<ClientConfig['authClient']>;

/**
 * The options both clients are built with.
 *
 * `libName` and `libVersion` reach the `x-goog-api-client` header through gax,
 * but `@google-cloud/pubsub` does not declare them on `ClientConfig`. The two
 * fields that are declared are picked from it rather than restated, and the
 * rest is left out because `ClientConfig` and the generated client's options
 * type disagree on `port`.
 */
type PubSubClientOptions = Pick<ClientConfig, 'projectId' | 'authClient'> & {
  libName: string;
  libVersion: string;
};

/** Which identity a client speaks as, and how it identifies itself. */
export interface PubSubClientRequest {
  authClient: PubSubAuthClient;
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
 * Serial numbers standing in for adk-python's `id(credentials)`.
 *
 * The map is weak, so an auth client that goes out of scope takes its number
 * with it. Two configs never collide on one number.
 */
const credentialIds = new WeakMap<object, number>();
let nextCredentialId = 0;

/** The stable number identifying one auth client. */
function credentialId(authClient: PubSubAuthClient): number {
  const known = credentialIds.get(authClient);
  if (known !== undefined) {
    return known;
  }
  nextCredentialId += 1;
  credentialIds.set(authClient, nextCredentialId);
  return nextCredentialId;
}

/**
 * The cache key for one request. JSON keeps two components apart that a
 * plain join would merge.
 */
function cacheKey(request: PubSubClientRequest): string {
  return JSON.stringify([
    credentialId(request.authClient),
    request.userAgent ?? [],
  ]);
}

/** The options every Pub/Sub client is built with. */
function clientOptions(request: PubSubClientRequest): PubSubClientOptions {
  return {
    projectId: request.projectId,
    authClient: request.authClient,
    libName: PUBSUB_USER_AGENT,
    libVersion: version,
  };
}

const publisherCache = new ClientCache<PubSub>(CACHE_MAX_SIZE);
// Unbounded, matching adk-python, whose subscriber cache is a plain dict with
// a TTL while its publisher cache is a bounded `OrderedDict`.
const subscriberCache = new ClientCache<SubscriberClient>();

/**
 * Returns the publisher client for one credential, building it on first use.
 *
 * `@google-cloud/pubsub` is an optional peer dependency and is imported only
 * here, so that importing `@google/adk` never resolves it.
 *
 * @param request Which identity to publish as.
 * @return The cached client.
 */
export function getPublisherClient(
  request: PubSubClientRequest,
): Promise<PubSub> {
  return publisherCache.get(cacheKey(request), async () => {
    const {PubSub: PubSubClient} = await loadOptionalPeer(
      PUBSUB_PEER,
      () => import('@google-cloud/pubsub'),
    );
    return new PubSubClient(clientOptions(request));
  });
}

/**
 * Returns the subscriber client for one credential, building it on first use.
 *
 * The high-level `Subscription` class only streams, so the synchronous pull
 * and acknowledge calls go through the generated `v1.SubscriberClient`.
 *
 * @param request Which identity to pull as.
 * @return The cached client.
 */
export function getSubscriberClient(
  request: PubSubClientRequest,
): Promise<SubscriberClient> {
  return subscriberCache.get(cacheKey(request), async () => {
    const {v1: generated} = await loadOptionalPeer(
      PUBSUB_PEER,
      () => import('@google-cloud/pubsub'),
    );
    return new generated.SubscriberClient(clientOptions(request));
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
