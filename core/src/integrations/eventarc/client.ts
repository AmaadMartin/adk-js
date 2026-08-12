/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {PublisherClient} from '@google-cloud/eventarc-publishing';
import {AuthClient} from 'google-auth-library';
import {createHash} from 'node:crypto';

import {logger} from '../../utils/logger.js';
import {version} from '../../version.js';
import {EventarcCredentialsConfig, resolveScopes} from './config.js';

/** Constructor of the optional Eventarc publishing client. */
export type PublisherClientCtor = typeof PublisherClient;

/** Maximum number of publisher clients kept alive at the same time. */
export const CACHE_MAX_SIZE = 10;

/** Time after which a cached publisher client is rebuilt. */
export const CACHE_TTL_MS = 30 * 60 * 1000;

/**
 * Error reported when the optional Eventarc publishing SDK cannot be loaded.
 *
 * `message_tool` turns this into the model-facing `ERROR` result, mirroring the
 * `ImportError` guard of the Python reference.
 */
export const EVENTARC_SDK_MISSING_ERROR =
  '@google-cloud/eventarc-publishing is not installed';

/**
 * Reported to the API as `x-goog-api-client`. Matches the Python reference's
 * `adk-eventarc-tool google-adk/<version>` user agent.
 */
const USER_AGENT_LIB_NAME = 'adk-eventarc-tool google-adk';

/** Identity used when no auth client is supplied. */
const DEFAULT_CREDENTIAL_ID = 'default';

/** Options selecting which cached publisher client to operate on. */
export interface PublisherClientOptions {
  credentialsConfig?: EventarcCredentialsConfig;
  projectId?: string;
}

interface CacheEntry {
  client: PublisherClient;
  expiresAt: number;
}

/**
 * Insertion-ordered LRU cache. A `Map` preserves insertion order, so deleting
 * and re-inserting a key moves it to the most-recently-used end and
 * `keys().next()` yields the least-recently-used one.
 */
const publisherClientCache = new Map<string, CacheEntry>();

const anonymousCredentialIds = new WeakMap<AuthClient, string>();
let anonymousCredentialCount = 0;

/**
 * Loads the optional `@google-cloud/eventarc-publishing` SDK.
 *
 * @throws An error carrying {@link EVENTARC_SDK_MISSING_ERROR} when the package
 *     is not installed.
 */
export async function loadPublisherClientCtor(): Promise<PublisherClientCtor> {
  try {
    const sdk = await import('@google-cloud/eventarc-publishing');
    return sdk.PublisherClient;
  } catch {
    throw new Error(EVENTARC_SDK_MISSING_ERROR);
  }
}

/**
 * Returns a cached publisher client, constructing one when the cache misses or
 * the cached entry has expired.
 *
 * Clients dropped by expiry or LRU eviction are closed before returning.
 */
export async function getPublisherClient(
  options: PublisherClientOptions,
): Promise<PublisherClient> {
  const publisherClientCtor = await loadPublisherClientCtor();
  const cacheKey = buildCacheKey(options);
  const now = Date.now();
  const staleClients: PublisherClient[] = [];

  const cached = publisherClientCache.get(cacheKey);
  if (cached) {
    publisherClientCache.delete(cacheKey);
    if (cached.expiresAt > now) {
      publisherClientCache.set(cacheKey, cached);
      return cached.client;
    }
    staleClients.push(cached.client);
  }

  const client = new publisherClientCtor({
    authClient: options.credentialsConfig?.authClient,
    scopes: resolveScopes(options.credentialsConfig),
    projectId: options.projectId,
    libName: USER_AGENT_LIB_NAME,
    libVersion: version,
  });

  if (publisherClientCache.size >= CACHE_MAX_SIZE) {
    const evictedKey = publisherClientCache.keys().next().value;
    if (evictedKey !== undefined) {
      const evicted = publisherClientCache.get(evictedKey);
      publisherClientCache.delete(evictedKey);
      if (evicted) {
        staleClients.push(evicted.client);
      }
    }
  }

  publisherClientCache.set(cacheKey, {client, expiresAt: now + CACHE_TTL_MS});

  await Promise.all(staleClients.map(closeClient));
  return client;
}

/**
 * Drops the cached publisher client for the given options and closes it, so
 * that the next publish rebuilds the underlying channel.
 */
export async function removePublisherClient(
  options: PublisherClientOptions,
): Promise<void> {
  const cacheKey = buildCacheKey(options);
  const entry = publisherClientCache.get(cacheKey);
  if (!entry) {
    return;
  }
  publisherClientCache.delete(cacheKey);
  await closeClient(entry.client);
}

/** Closes and drops every cached publisher client. */
export async function cleanupPublisherClients(): Promise<void> {
  const entries = [...publisherClientCache.values()];
  publisherClientCache.clear();
  await Promise.all(entries.map((entry) => closeClient(entry.client)));
}

async function closeClient(client: PublisherClient): Promise<void> {
  try {
    await client.close();
  } catch (error: unknown) {
    logger.warn('Failed to close the Eventarc publisher client', error);
  }
}

function buildCacheKey(options: PublisherClientOptions): string {
  return [
    options.projectId ?? '',
    resolveScopes(options.credentialsConfig).join(','),
    credentialId(options.credentialsConfig?.authClient),
  ].join('|');
}

/**
 * Derives a stable identity for an auth client so that equivalent credentials
 * share a channel.
 *
 * Only the identities `google-auth-library` actually exposes are recognised;
 * anything else falls back to a per-object identifier, which is correct but
 * does not deduplicate.
 */
function credentialId(authClient?: AuthClient): string {
  if (!authClient) {
    return DEFAULT_CREDENTIAL_ID;
  }

  const email = readStringField(authClient, 'email');
  if (email) {
    return email;
  }

  const targetPrincipal = readStringField(authClient, 'targetPrincipal');
  if (targetPrincipal) {
    return `Impersonated:${targetPrincipal}`;
  }

  const audience = readStringField(authClient, 'audience');
  if (audience) {
    return `ExternalAccount:${audience}`;
  }

  const refreshToken = readStringField(authClient.credentials, 'refresh_token');
  if (refreshToken) {
    const digest = createHash('sha256').update(refreshToken).digest('hex');
    return `UserCredentials:${digest}`;
  }

  return anonymousCredentialId(authClient);
}

function readStringField(source: object, field: string): string | undefined {
  const value: unknown = Reflect.get(source, field);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function anonymousCredentialId(authClient: AuthClient): string {
  const existing = anonymousCredentialIds.get(authClient);
  if (existing !== undefined) {
    return existing;
  }
  anonymousCredentialCount += 1;
  const id = `AuthClient:${anonymousCredentialCount}`;
  anonymousCredentialIds.set(authClient, id);
  return id;
}
