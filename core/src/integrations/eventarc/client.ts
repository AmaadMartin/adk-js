/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A bounded cache of Eventarc publisher clients.
 *
 * Each client owns a gRPC channel, so one is shared by every publish that runs
 * with the same project and credentials. Entries expire after
 * {@link CACHE_TTL_MS} and the cache never holds more than
 * {@link CACHE_MAX_SIZE}; whenever an entry leaves the cache its channel is
 * closed.
 */

import {createHash} from 'node:crypto';
import {formatError} from '../../utils/error_utils.js';
import {logger} from '../../utils/logger.js';
import {version} from '../../version.js';
import type {EventarcCredentialsConfig} from './config.js';
import {loadEventarcSdk, type PublisherClient} from './sdk.js';

/** How long a cached client stays usable. */
const CACHE_TTL_MS = 30 * 60 * 1000;

/** How many clients the cache holds before it evicts the oldest. */
const CACHE_MAX_SIZE = 10;

/** Reported to the API as the calling library. */
const CLIENT_LIB_NAME = 'adk-eventarc-tool';

/** What a client is built for. Two requests that agree here share a client. */
export interface PublisherClientRequest {
  /** How the client authenticates. Omit for Application Default Credentials. */
  credentialsConfig?: EventarcCredentialsConfig;
  /** The project the client bills and reports telemetry against. */
  projectId?: string;
}

interface CacheEntry {
  /** The pending client, cached before it resolves so callers cannot race. */
  client: Promise<PublisherClient>;
  expiresAt: number;
}

const publisherClientCache = new Map<string, CacheEntry>();

/**
 * Renders a credentials config as a canonical string, with its keys ordered so
 * that two structurally equal configs render identically.
 */
function credentialDescriptor(config?: EventarcCredentialsConfig): string {
  const credentials: Array<[string, string]> | null =
    config?.credentials === undefined
      ? null
      : Object.entries(config.credentials);
  return JSON.stringify([
    credentials?.sort() ?? null,
    config?.keyFilename ?? null,
    config?.scopes ?? null,
  ]);
}

/**
 * Returns the cache key for a client request.
 *
 * The credentials are reduced to a SHA-256 digest so that a private key or a
 * refresh token never sits in a map key, where a heap dump would expose it.
 *
 * @param request The project and credentials the client is built for.
 * @return A key that is equal for equal requests and differs otherwise.
 */
export function publisherCacheKey(request: PublisherClientRequest): string {
  const digest = createHash('sha256')
    .update(credentialDescriptor(request.credentialsConfig))
    .digest('hex');
  return JSON.stringify([request.projectId ?? null, digest]);
}

/** Closes a client's channel, reporting a failure rather than raising it. */
async function closeQuietly(client: Promise<PublisherClient>): Promise<void> {
  try {
    await (await client).close();
  } catch (err: unknown) {
    logger.debug(
      'Failed to close an Eventarc publisher client:',
      formatError(err),
    );
  }
}

/** Builds a publisher client, loading the SDK on first use. */
async function createPublisherClient(
  request: PublisherClientRequest,
): Promise<PublisherClient> {
  const {PublisherClient} = await loadEventarcSdk();
  return new PublisherClient({
    libName: CLIENT_LIB_NAME,
    libVersion: version,
    projectId: request.projectId,
    credentials: request.credentialsConfig?.credentials,
    keyFilename: request.credentialsConfig?.keyFilename,
    scopes: request.credentialsConfig?.scopes,
  });
}

/**
 * Returns the publisher client for a request, building one when the cache
 * holds no live entry for it.
 *
 * The cache is updated before the first `await`, so two concurrent callers
 * share one client instead of each building their own.
 *
 * @param request The project and credentials the client is built for.
 * @return The cached or newly built client.
 */
export async function getPublisherClient(
  request: PublisherClientRequest,
): Promise<PublisherClient> {
  const key = publisherCacheKey(request);
  const now = Date.now();

  const cached = publisherClientCache.get(key);
  publisherClientCache.delete(key);
  if (cached !== undefined && cached.expiresAt > now) {
    publisherClientCache.set(key, cached);
    return cached.client;
  }

  const oldest = publisherClientCache.entries().next();
  const evicted =
    publisherClientCache.size >= CACHE_MAX_SIZE && !oldest.done
      ? oldest.value
      : undefined;
  if (evicted !== undefined) {
    publisherClientCache.delete(evicted[0]);
  }

  const entry: CacheEntry = {
    client: createPublisherClient(request),
    expiresAt: now + CACHE_TTL_MS,
  };
  publisherClientCache.set(key, entry);

  if (cached !== undefined) {
    await closeQuietly(cached.client);
  }
  if (evicted !== undefined) {
    await closeQuietly(evicted[1].client);
  }
  return entry.client;
}

/**
 * Drops a client from the cache and closes its channel, so that the next
 * publish for the same request reconnects.
 *
 * Removing a request that is not cached does nothing.
 *
 * @param request The project and credentials the client was built for.
 */
export async function removePublisherClient(
  request: PublisherClientRequest,
): Promise<void> {
  const key = publisherCacheKey(request);
  const entry = publisherClientCache.get(key);
  if (entry === undefined) {
    return;
  }
  publisherClientCache.delete(key);
  await closeQuietly(entry.client);
}

/** Closes every cached publisher client and empties the cache. */
export async function cleanupClients(): Promise<void> {
  const entries = [...publisherClientCache.values()];
  publisherClientCache.clear();
  await Promise.all(entries.map((entry) => closeQuietly(entry.client)));
}
