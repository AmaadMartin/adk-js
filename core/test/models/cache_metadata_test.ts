/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CacheMetadata,
  CacheMetadataInput,
  createCacheMetadata,
  expireSoon,
  formatCacheMetadata,
} from '@google/adk';
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

const CACHE_NAME = 'projects/123/locations/us-central1/cachedContents/456';

function activeInput(overrides: Partial<CacheMetadataInput> = {}) {
  return {
    cacheName: CACHE_NAME,
    expireTime: NOW_SECONDS + 1800,
    fingerprint: 'abc123',
    invocationsUsed: 5,
    contentsCount: 3,
    ...overrides,
  };
}

// Ported from adk-python tests/unittests/models/test_cache_metadata.py
// (branch main, commit 864914ba).
describe('cache_metadata parity with adk-python', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_required_fields', () => {
    const metadata = createCacheMetadata(activeInput());

    expect(metadata.cacheName).toBe(CACHE_NAME);
    expect(metadata.expireTime).toBeGreaterThan(NOW_SECONDS);
    expect(metadata.fingerprint).toBe('abc123');
    expect(metadata.invocationsUsed).toBe(5);
    expect(metadata.contentsCount).toBe(3);
    expect(metadata.createdAt).toBeUndefined();
  });

  it('test_optional_created_at', () => {
    const metadata = createCacheMetadata(
      activeInput({
        invocationsUsed: 3,
        contentsCount: 2,
        createdAt: NOW_SECONDS,
      }),
    );

    expect(metadata.createdAt).toBe(NOW_SECONDS);
  });

  it('test_invocations_used_validation', () => {
    expect(
      createCacheMetadata(activeInput({invocationsUsed: 0, contentsCount: 1}))
        .invocationsUsed,
    ).toBe(0);
    expect(
      createCacheMetadata(activeInput({invocationsUsed: 10, contentsCount: 1}))
        .invocationsUsed,
    ).toBe(10);

    // Divergence: adk-python asserts pydantic's "greater than or equal to 0".
    expect(() =>
      createCacheMetadata(activeInput({invocationsUsed: -1, contentsCount: 1})),
    ).toThrow('invocationsUsed must be a non-negative integer.');
  });

  it('test_contents_count_validation', () => {
    expect(
      createCacheMetadata(activeInput({invocationsUsed: 1, contentsCount: 0}))
        .contentsCount,
    ).toBe(0);
    expect(
      createCacheMetadata(activeInput({invocationsUsed: 1, contentsCount: 10}))
        .contentsCount,
    ).toBe(10);

    // Divergence: adk-python asserts pydantic's "greater than or equal to 0".
    expect(() =>
      createCacheMetadata(activeInput({invocationsUsed: 1, contentsCount: -1})),
    ).toThrow('contentsCount must be a non-negative integer.');
  });

  it('test_expire_soon_property', () => {
    const later = createCacheMetadata(
      activeInput({
        expireTime: NOW_SECONDS + 600,
        invocationsUsed: 1,
        contentsCount: 1,
      }),
    );
    expect(expireSoon(later)).toBe(false);

    const soon = createCacheMetadata(
      activeInput({
        expireTime: NOW_SECONDS + 60,
        invocationsUsed: 1,
        contentsCount: 1,
      }),
    );
    expect(expireSoon(soon)).toBe(true);
  });

  it('test_str_representation', () => {
    const metadata = createCacheMetadata(
      activeInput({
        cacheName: 'projects/123/locations/us-central1/cachedContents/test456',
        expireTime: NOW_SECONDS + 1800,
        invocationsUsed: 7,
        contentsCount: 4,
      }),
    );

    const rendered = formatCacheMetadata(metadata);
    expect(rendered).toContain('test456');
    expect(rendered).toContain('used 7 invocations');
    expect(rendered).toContain('cached 4 contents');
    expect(rendered).toContain('expires in');
  });

  it('test_immutability', () => {
    const metadata: {invocationsUsed?: number} =
      createCacheMetadata(activeInput());

    expect(() => {
      metadata.invocationsUsed = 10;
    }).toThrow(TypeError);
  });

  it('test_realistic_cache_scenarios', () => {
    const fresh = createCacheMetadata({
      cacheName: 'projects/123/locations/us-central1/cachedContents/fresh123',
      expireTime: NOW_SECONDS + 1800,
      fingerprint: 'fresh_fingerprint',
      invocationsUsed: 1,
      contentsCount: 5,
      createdAt: NOW_SECONDS,
    });
    expect(fresh.invocationsUsed).toBe(1);
    expect(expireSoon(fresh)).toBe(false);

    const used = createCacheMetadata({
      cacheName: 'projects/123/locations/us-central1/cachedContents/used456',
      expireTime: NOW_SECONDS + 600,
      fingerprint: 'used_fingerprint',
      invocationsUsed: 8,
      contentsCount: 3,
      createdAt: NOW_SECONDS - 1200,
    });
    expect(used.invocationsUsed).toBe(8);

    const expiring = createCacheMetadata({
      cacheName:
        'projects/123/locations/us-central1/cachedContents/expiring789',
      expireTime: NOW_SECONDS + 60,
      fingerprint: 'expiring_fingerprint',
      invocationsUsed: 15,
      contentsCount: 10,
    });
    expect(expireSoon(expiring)).toBe(true);
  });

  it('test_cache_name_extraction', () => {
    const metadata = createCacheMetadata(
      activeInput({
        cacheName:
          'projects/123/locations/us-central1/cachedContents/extracted_id',
        invocationsUsed: 1,
        contentsCount: 2,
      }),
    );

    expect(formatCacheMetadata(metadata)).toContain('extracted_id');
  });

  it('test_no_performance_metrics', () => {
    const metadata = createCacheMetadata(activeInput());

    expect('cachedTokens' in metadata).toBe(false);
    expect('totalTokens' in metadata).toBe(false);
    expect('promptTokens' in metadata).toBe(false);
  });

  it('test_missing_required_fields', () => {
    // adk-python also asserts that omitting a required field raises. Here that
    // is a compile error, so only the fingerprint-only half is testable.
    const metadata = createCacheMetadata({
      fingerprint: 'abc123',
      contentsCount: 5,
    });

    expect(metadata.cacheName).toBeUndefined();
    expect(metadata.expireTime).toBeUndefined();
    expect(metadata.invocationsUsed).toBeUndefined();
    expect(metadata.createdAt).toBeUndefined();
  });

  it('test_partial_active_state_rejected', () => {
    const message =
      'cacheName, expireTime and invocationsUsed must all be set (active ' +
      'cache) or all be undefined (fingerprint-only state).';

    expect(() =>
      createCacheMetadata({
        cacheName: 'projects/123/locations/us-central1/cachedContents/x',
        fingerprint: 'abc',
        contentsCount: 1,
      }),
    ).toThrow(message);

    expect(() =>
      createCacheMetadata({
        cacheName: 'projects/123/locations/us-central1/cachedContents/x',
        expireTime: NOW_SECONDS + 1800,
        fingerprint: 'abc',
        contentsCount: 1,
      }),
    ).toThrow(message);

    expect(() =>
      createCacheMetadata({
        fingerprint: 'abc',
        invocationsUsed: 3,
        contentsCount: 1,
      }),
    ).toThrow(message);
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

  it('renders fingerprint-only metadata with a truncated fingerprint', () => {
    const metadata = createCacheMetadata({
      fingerprint: 'abcdef0123456789',
      contentsCount: 3,
    });

    expect(formatCacheMetadata(metadata)).toBe(
      'Fingerprint-only: 3 contents, fingerprint=abcdef01...',
    );
  });

  it('renders a fingerprint shorter than the prefix length in full', () => {
    const metadata = createCacheMetadata({
      fingerprint: 'abc',
      contentsCount: 1,
    });

    expect(formatCacheMetadata(metadata)).toBe(
      'Fingerprint-only: 1 contents, fingerprint=abc...',
    );
  });

  it('reports fingerprint-only metadata as never expiring', () => {
    expect(
      expireSoon(createCacheMetadata({fingerprint: 'abc', contentsCount: 1})),
    ).toBe(false);
  });

  it('treats the expiry buffer boundary as not expiring soon', () => {
    const atBoundary = createCacheMetadata(
      activeInput({expireTime: NOW_SECONDS + 120}),
    );
    expect(expireSoon(atBoundary)).toBe(false);

    const insideBoundary = createCacheMetadata(
      activeInput({expireTime: NOW_SECONDS + 119}),
    );
    expect(expireSoon(insideBoundary)).toBe(true);
  });

  it('renders a negative minute count for an expired cache', () => {
    const expired = createCacheMetadata(
      activeInput({expireTime: NOW_SECONDS - 192, invocationsUsed: 2}),
    );

    expect(formatCacheMetadata(expired)).toBe(
      'Cache 456: used 2 invocations, cached 3 contents, expires in -3.2min',
    );
  });

  it('rejects a non-integer count', () => {
    expect(() =>
      createCacheMetadata({fingerprint: 'abc', contentsCount: 1.5}),
    ).toThrow('contentsCount must be a non-negative integer.');

    expect(() =>
      createCacheMetadata(activeInput({invocationsUsed: 1.5})),
    ).toThrow('invocationsUsed must be a non-negative integer.');
  });
});
