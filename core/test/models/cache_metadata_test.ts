/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CacheMetadata, expireSoon, formatCacheMetadata} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

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

describe('CacheMetadata narrowing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes the active fields once cacheName is known to be set', () => {
    const metadata = activeMetadata(NOW_SECONDS + 600);
    if (metadata.cacheName === undefined) {
      expect.fail('expected active cache metadata');
    }
    expect(formatCacheMetadata(metadata)).toBe(
      'Cache 456: used 7 invocations, cached 5 contents, expires in 10.0min',
    );
    expect(expireSoon(metadata)).toBe(false);
  });

  it('hides the active fields on fingerprint-only metadata', () => {
    expect(formatCacheMetadata(FINGERPRINT_ONLY)).toBe(
      'Fingerprint-only: 3 contents, fingerprint=abcdef01...',
    );
    expect(expireSoon(FINGERPRINT_ONLY)).toBe(false);
  });
});

const CACHE_NAME = 'projects/123/locations/us-central1/cachedContents/456';

function activeCache(overrides: Partial<CacheMetadata> = {}): CacheMetadata {
  return {
    cacheName: CACHE_NAME,
    expireTime: NOW_SECONDS + 1800,
    invocationsUsed: 5,
    fingerprint: 'abc123',
    contentsCount: 3,
    ...overrides,
  };
}

// Ported from adk-python tests/unittests/models/test_cache_metadata.py
// (branch main, commit 864914ba). The reference tests that pin pydantic's
// runtime validation, freezing and schema introspection have no counterpart
// here: this module is a plain interface, so TypeScript pins the same shape at
// compile time.
describe('cache_metadata parity with adk-python', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_expire_soon_property', () => {
    expect(expireSoon(activeCache({expireTime: NOW_SECONDS + 600}))).toBe(
      false,
    );
    expect(expireSoon(activeCache({expireTime: NOW_SECONDS + 60}))).toBe(true);
  });

  it('test_str_representation', () => {
    const rendered = formatCacheMetadata(
      activeCache({
        cacheName: 'projects/123/locations/us-central1/cachedContents/test456',
        invocationsUsed: 7,
        contentsCount: 4,
      }),
    );

    expect(rendered).toContain('test456');
    expect(rendered).toContain('used 7 invocations');
    expect(rendered).toContain('cached 4 contents');
    expect(rendered).toContain('expires in');
  });

  it('test_realistic_cache_scenarios', () => {
    const fresh = activeCache({
      cacheName: 'projects/123/locations/us-central1/cachedContents/fresh123',
      expireTime: NOW_SECONDS + 1800,
      invocationsUsed: 1,
      contentsCount: 5,
      createdAt: NOW_SECONDS,
    });
    expect(expireSoon(fresh)).toBe(false);
    expect(formatCacheMetadata(fresh)).toContain('used 1 invocations');

    const used = activeCache({
      cacheName: 'projects/123/locations/us-central1/cachedContents/used456',
      expireTime: NOW_SECONDS + 600,
      invocationsUsed: 8,
      contentsCount: 3,
      createdAt: NOW_SECONDS - 1200,
    });
    expect(formatCacheMetadata(used)).toContain('used 8 invocations');

    const expiring = activeCache({
      cacheName:
        'projects/123/locations/us-central1/cachedContents/expiring789',
      expireTime: NOW_SECONDS + 60,
      invocationsUsed: 15,
      contentsCount: 10,
    });
    expect(expireSoon(expiring)).toBe(true);
  });

  it('test_cache_name_extraction', () => {
    const metadata = activeCache({
      cacheName:
        'projects/123/locations/us-central1/cachedContents/extracted_id',
      invocationsUsed: 1,
      contentsCount: 2,
    });

    expect(formatCacheMetadata(metadata)).toContain('extracted_id');
  });
});

describe('cache_metadata behaviour adk-python does not cover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a fingerprint shorter than the prefix length in full', () => {
    expect(formatCacheMetadata({fingerprint: 'abc', contentsCount: 1})).toBe(
      'Fingerprint-only: 1 contents, fingerprint=abc...',
    );
  });

  it('treats the expiry buffer boundary as not expiring soon', () => {
    expect(expireSoon(activeCache({expireTime: NOW_SECONDS + 120}))).toBe(
      false,
    );
    expect(expireSoon(activeCache({expireTime: NOW_SECONDS + 119}))).toBe(true);
  });

  it('renders a negative minute count for an expired cache', () => {
    const expired = activeCache({
      expireTime: NOW_SECONDS - 192,
      invocationsUsed: 2,
    });

    expect(formatCacheMetadata(expired)).toBe(
      'Cache 456: used 2 invocations, cached 3 contents, expires in -3.2min',
    );
  });

  it('renders a cache name that has no slash', () => {
    expect(
      formatCacheMetadata(activeCache({cacheName: 'bare-name'})),
    ).toContain('Cache bare-name:');
  });
});
