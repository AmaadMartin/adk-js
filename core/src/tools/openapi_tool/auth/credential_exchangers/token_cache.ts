/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  ServiceAccount,
} from '../../../../auth/auth_credential.js';

/** Assumed lifetime of a token whose real expiry cannot be read. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

/** How long before its expiry a cached token stops being served. */
const CACHE_EXPIRY_SKEW_SECONDS = 300;

/** Entries held before the oldest is evicted. */
const MAX_CACHED_TOKENS = 100;

interface CachedToken {
  credential: AuthCredential;
  expiresAtSeconds: number;
}

// One map, unlike the reference's two: `useIdToken` is part of the cache key.
const tokenCache = new Map<string, CachedToken>();

function nowSeconds(): number {
  return Date.now() / 1000;
}

/**
 * Builds the cache key for a service account configuration. Two configurations
 * share a token only when every field that changes the minted token matches.
 */
function cacheKey(saConfig: ServiceAccount): string {
  const creds = saConfig.serviceAccountCredential;
  return JSON.stringify([
    saConfig.useDefaultCredential === true,
    creds?.privateKeyId ?? null,
    creds?.clientEmail ?? null,
    saConfig.scopes ?? [],
    saConfig.useIdToken === true,
    saConfig.audience ?? null,
  ]);
}

/** The expiry to assume for a token that does not report one. */
export function defaultExpirySeconds(): number {
  return nowSeconds() + DEFAULT_TOKEN_LIFETIME_SECONDS;
}

/**
 * Returns the token cached for a configuration, or `undefined` when there is
 * none or it is within the skew window of its expiry.
 */
export function getCachedToken(
  saConfig: ServiceAccount,
): AuthCredential | undefined {
  const cached = tokenCache.get(cacheKey(saConfig));
  if (
    cached &&
    nowSeconds() < cached.expiresAtSeconds - CACHE_EXPIRY_SKEW_SECONDS
  ) {
    return cached.credential;
  }
  return undefined;
}

/**
 * Caches a token, evicting the oldest entry once the cache is full. The
 * reference cache is unbounded; a long-running agent needs a cap.
 */
export function cacheToken(
  saConfig: ServiceAccount,
  credential: AuthCredential,
  expiresAtSeconds: number,
): void {
  const key = cacheKey(saConfig);
  tokenCache.delete(key);
  if (tokenCache.size >= MAX_CACHED_TOKENS) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) {
      tokenCache.delete(oldest);
    }
  }
  tokenCache.set(key, {credential, expiresAtSeconds});
}

/** Clears the token cache. Test-only. */
export function resetServiceAccountTokenCache(): void {
  tokenCache.clear();
}
