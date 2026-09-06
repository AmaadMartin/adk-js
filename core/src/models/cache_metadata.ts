/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';

/** Fields that both cache states carry. */
interface CacheMetadataBase {
  /**
   * Hash of the cacheable contents (system instruction, tools and the cached
   * content prefix). It detects a change that invalidates the cache.
   */
  readonly fingerprint: string;

  /**
   * Number of cached contents when a cache is active, otherwise the length of
   * the cacheable content prefix that the fingerprint covers.
   */
  readonly contentsCount: number;

  /** Unix timestamp in seconds when the cache was created. */
  readonly createdAt?: number;
}

/**
 * Metadata for a live context cache.
 *
 * Token counts are not repeated here. Read them from
 * `LlmResponse.usageMetadata`.
 */
export interface ActiveCacheMetadata extends CacheMetadataBase {
  /**
   * Full resource name of the cached content, for example
   * `projects/123/locations/us-central1/cachedContents/456`.
   */
  readonly cacheName: string;

  /** Unix timestamp in seconds when the cache expires. */
  readonly expireTime: number;

  /** Number of invocations this cache has served. */
  readonly invocationsUsed: number;
}

/** Metadata for a fingerprinted content prefix that has no cache behind it. */
export interface FingerprintCacheMetadata extends CacheMetadataBase {
  readonly cacheName?: undefined;
  readonly expireTime?: undefined;
  readonly invocationsUsed?: undefined;
}

/**
 * Metadata for the context cache that served an LLM response.
 *
 * The union makes the two states of `adk-python`'s `CacheMetadata` explicit: a
 * cache is either active, and then it has a name, an expiry and a use count, or
 * it is fingerprint-only, and then it has none of them. A half-populated record
 * does not type-check, and {@link parseCacheMetadata} rejects one that arrives
 * at runtime.
 */
export type CacheMetadata = ActiveCacheMetadata | FingerprintCacheMetadata;

/** Slack allowed for processing time when judging an imminent expiry. */
const EXPIRY_BUFFER_SECONDS = 120;

/** Characters of the fingerprint that {@link formatCacheMetadata} shows. */
const FINGERPRINT_PREFIX_LENGTH = 8;

const SECONDS_PER_MINUTE = 60;

/** Fields that must all be set together, or all be absent. */
const ACTIVE_STATE_ERROR =
  'cacheName, expireTime and invocationsUsed must all be set (active cache) ' +
  'or all be undefined (fingerprint-only state).';

/** A count field, with one message for every way it can be wrong. */
function nonNegativeInteger(field: string) {
  const error = `${field} must be a non-negative integer.`;
  return z.number({error}).int({error}).nonnegative({error});
}

const cacheMetadataSchema = z.strictObject({
  fingerprint: z.string({error: 'fingerprint must be a string.'}),
  contentsCount: nonNegativeInteger('contentsCount'),
  cacheName: z.string({error: 'cacheName must be a string.'}).optional(),
  expireTime: z.number({error: 'expireTime must be a number.'}).optional(),
  invocationsUsed: nonNegativeInteger('invocationsUsed').optional(),
  createdAt: z.number({error: 'createdAt must be a number.'}).optional(),
});

function nowSeconds(): number {
  return Date.now() / 1000;
}

/**
 * Reports whether an active cache expires within the processing buffer.
 *
 * Fingerprint-only metadata has no cache behind it, so it never expires.
 *
 * @param metadata The metadata to inspect.
 * @returns True if the cache expires in less than two minutes.
 */
export function expireSoon(metadata: CacheMetadata): boolean {
  if (metadata.expireTime === undefined) {
    return false;
  }
  return nowSeconds() > metadata.expireTime - EXPIRY_BUFFER_SECONDS;
}

/**
 * Renders the metadata as a single line for a log message.
 *
 * @param metadata The metadata to render.
 * @returns A description of the cache, or of the fingerprinted prefix.
 */
export function formatCacheMetadata(metadata: CacheMetadata): string {
  if (metadata.cacheName === undefined) {
    const prefix = metadata.fingerprint.slice(0, FINGERPRINT_PREFIX_LENGTH);
    return `Fingerprint-only: ${metadata.contentsCount} contents, fingerprint=${prefix}...`;
  }

  const cacheId = metadata.cacheName.slice(
    metadata.cacheName.lastIndexOf('/') + 1,
  );
  const minutesToExpiry =
    (metadata.expireTime - nowSeconds()) / SECONDS_PER_MINUTE;
  return (
    `Cache ${cacheId}: used ${metadata.invocationsUsed} invocations, ` +
    `cached ${metadata.contentsCount} contents, ` +
    `expires in ${minutesToExpiry.toFixed(1)}min`
  );
}

/**
 * Validates a value that arrives as `unknown`, typically from persisted JSON.
 *
 * The compiler already guarantees the shape of a record built in TypeScript.
 * This is the boundary check for a value it never saw: it rejects an unknown
 * field, a count that is not a non-negative integer, and a record that sets
 * only some of the three active-cache fields.
 *
 * @param value The value to validate.
 * @returns A frozen record. A later write to it throws a `TypeError`.
 * @throws InputValidationError If the value is not valid cache metadata.
 */
export function parseCacheMetadata(value: unknown): CacheMetadata {
  const parsed = cacheMetadataSchema.safeParse(value);
  if (!parsed.success) {
    throw new InputValidationError(parsed.error.issues[0].message);
  }

  const {cacheName, expireTime, invocationsUsed, ...rest} = parsed.data;
  if (
    cacheName !== undefined &&
    expireTime !== undefined &&
    invocationsUsed !== undefined
  ) {
    return Object.freeze({...rest, cacheName, expireTime, invocationsUsed});
  }
  if (
    cacheName !== undefined ||
    expireTime !== undefined ||
    invocationsUsed !== undefined
  ) {
    throw new InputValidationError(ACTIVE_STATE_ERROR);
  }
  return Object.freeze(rest);
}
