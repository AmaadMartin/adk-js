/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CacheMetadata,
  formatCacheMetadata,
  isCacheExpiringSoon,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

/** Fixed wall clock so every expiry figure in this file is deterministic. */
const NOW_SECONDS = 1_700_000_000;

const FINGERPRINT_ONLY: CacheMetadata = {
  fingerprint: 'abcdef0123456789',
  contentsCount: 3,
};

function activeMetadata(expireTime: number): CacheMetadata {
  return {
    cacheName: 'projects/123/locations/us-central1/cachedContents/456',
    expireTime,
    invocationsUsed: 7,
    fingerprint: 'abcdef0123456789',
    contentsCount: 5,
    createdAt: NOW_SECONDS - 60,
  };
}

function pinClock(): void {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SECONDS * 1000);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('isCacheExpiringSoon', () => {
  it('returns false for fingerprint-only metadata', () => {
    pinClock();
    expect(isCacheExpiringSoon(FINGERPRINT_ONLY)).toBe(false);
  });

  it('returns true when the cache expires inside the 120s buffer', () => {
    pinClock();
    expect(isCacheExpiringSoon(activeMetadata(NOW_SECONDS + 119))).toBe(true);
  });

  it('returns false when the cache expires beyond the 120s buffer', () => {
    pinClock();
    expect(isCacheExpiringSoon(activeMetadata(NOW_SECONDS + 121))).toBe(false);
  });

  it('returns true for a cache that already expired', () => {
    pinClock();
    expect(isCacheExpiringSoon(activeMetadata(NOW_SECONDS - 600))).toBe(true);
  });
});

describe('formatCacheMetadata', () => {
  it('reports the contents count and the fingerprint prefix when no cache is active', () => {
    pinClock();
    expect(formatCacheMetadata(FINGERPRINT_ONLY)).toBe(
      'Fingerprint-only: 3 contents, fingerprint=abcdef01...',
    );
  });

  it('reports the cache id, usage and minutes to expiry when a cache is active', () => {
    pinClock();
    expect(formatCacheMetadata(activeMetadata(NOW_SECONDS + 630))).toBe(
      'Cache 456: used 7 invocations, cached 5 contents, expires in 10.5min',
    );
  });

  it('reports a negative expiry for a cache that already expired', () => {
    pinClock();
    expect(formatCacheMetadata(activeMetadata(NOW_SECONDS - 90))).toContain(
      'expires in -1.5min',
    );
  });
});

describe('CacheMetadata narrowing', () => {
  it('exposes the active fields once cacheName is known to be set', () => {
    const metadata = activeMetadata(NOW_SECONDS + 60);
    if (metadata.cacheName === undefined) {
      expect.fail('expected active cache metadata');
    }
    expect(metadata.expireTime).toBe(NOW_SECONDS + 60);
    expect(metadata.invocationsUsed).toBe(7);
  });

  it('hides the active fields on fingerprint-only metadata', () => {
    expect(FINGERPRINT_ONLY.cacheName).toBeUndefined();
    expect(FINGERPRINT_ONLY.expireTime).toBeUndefined();
    expect(FINGERPRINT_ONLY.invocationsUsed).toBeUndefined();
  });
});
