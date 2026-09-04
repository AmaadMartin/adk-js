/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CacheMetadata,
  InputValidationError,
  expireSoon,
  formatCacheMetadata,
  parseCacheMetadata,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const NOW_SECONDS = 1_700_000_000;

const CACHE_NAME = 'projects/123/locations/us-central1/cachedContents/456';

const FINGERPRINT_ONLY: CacheMetadata = {
  fingerprint: 'abcdef0123456789',
  contentsCount: 3,
};

function activeInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cacheName: CACHE_NAME,
    expireTime: NOW_SECONDS + 1800,
    fingerprint: 'abc123',
    invocationsUsed: 5,
    contentsCount: 3,
    ...overrides,
  };
}

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

/**
 * Ported from adk-python `tests/unittests/models/test_cache_metadata.py`,
 * branch `main`, commit 76b9f0baa0bcc4e715ee996b4dc894ffc9264583.
 *
 * The Python names are kept verbatim so a reader can grep the original. 13 of
 * the 14 reference tests are ported; `test_field_descriptions` reads a pydantic
 * JSON schema that this module has no counterpart for.
 */
describe('cache_metadata parity with adk-python', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('test_required_fields', () => {
    const metadata = parseCacheMetadata(activeInput());

    expect(metadata.cacheName).toBe(CACHE_NAME);
    expect(metadata.expireTime).toBeGreaterThan(NOW_SECONDS);
    expect(metadata.fingerprint).toBe('abc123');
    expect(metadata.invocationsUsed).toBe(5);
    expect(metadata.contentsCount).toBe(3);
    expect(metadata.createdAt).toBeUndefined();
  });

  it('test_optional_created_at', () => {
    const metadata = parseCacheMetadata(
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
      parseCacheMetadata(activeInput({invocationsUsed: 0, contentsCount: 1}))
        .invocationsUsed,
    ).toBe(0);
    expect(
      parseCacheMetadata(activeInput({invocationsUsed: 10, contentsCount: 1}))
        .invocationsUsed,
    ).toBe(10);

    expect(() =>
      parseCacheMetadata(activeInput({invocationsUsed: -1, contentsCount: 1})),
    ).toThrowError(
      new InputValidationError(
        'invocationsUsed must be a non-negative integer.',
      ),
    );
  });

  it('test_contents_count_validation', () => {
    expect(
      parseCacheMetadata(activeInput({invocationsUsed: 1, contentsCount: 0}))
        .contentsCount,
    ).toBe(0);
    expect(
      parseCacheMetadata(activeInput({invocationsUsed: 1, contentsCount: 10}))
        .contentsCount,
    ).toBe(10);

    expect(() =>
      parseCacheMetadata(activeInput({invocationsUsed: 1, contentsCount: -1})),
    ).toThrowError(
      new InputValidationError('contentsCount must be a non-negative integer.'),
    );
  });

  it('test_expire_soon_property', () => {
    const later = parseCacheMetadata(
      activeInput({
        expireTime: NOW_SECONDS + 600,
        invocationsUsed: 1,
        contentsCount: 1,
      }),
    );
    expect(expireSoon(later)).toBe(false);

    const soon = parseCacheMetadata(
      activeInput({
        expireTime: NOW_SECONDS + 60,
        invocationsUsed: 1,
        contentsCount: 1,
      }),
    );
    expect(expireSoon(soon)).toBe(true);
  });

  it('test_str_representation', () => {
    const rendered = formatCacheMetadata(
      parseCacheMetadata(
        activeInput({
          cacheName:
            'projects/123/locations/us-central1/cachedContents/test456',
          invocationsUsed: 7,
          contentsCount: 4,
        }),
      ),
    );

    expect(rendered).toContain('test456');
    expect(rendered).toContain('used 7 invocations');
    expect(rendered).toContain('cached 4 contents');
    expect(rendered).toContain('expires in');
  });

  it('test_immutability', () => {
    const metadata = parseCacheMetadata(activeInput());

    expect(() => Object.assign(metadata, {invocationsUsed: 10})).toThrowError(
      TypeError,
    );
    expect(metadata.invocationsUsed).toBe(5);
  });

  it('test_model_config', () => {
    // Python asserts extra="forbid" and frozen=True on model_config. There is
    // no such object here, so assert the two behaviours it configures.
    expect(() =>
      parseCacheMetadata(activeInput({unknownField: 1})),
    ).toThrowError(InputValidationError);
    expect(Object.isFrozen(parseCacheMetadata(activeInput()))).toBe(true);
  });

  it('test_realistic_cache_scenarios', () => {
    const fresh = parseCacheMetadata(
      activeInput({
        cacheName: 'projects/123/locations/us-central1/cachedContents/fresh123',
        expireTime: NOW_SECONDS + 1800,
        fingerprint: 'fresh_fingerprint',
        invocationsUsed: 1,
        contentsCount: 5,
        createdAt: NOW_SECONDS,
      }),
    );
    expect(fresh.invocationsUsed).toBe(1);
    expect(expireSoon(fresh)).toBe(false);

    const used = parseCacheMetadata(
      activeInput({
        cacheName: 'projects/123/locations/us-central1/cachedContents/used456',
        expireTime: NOW_SECONDS + 600,
        fingerprint: 'used_fingerprint',
        invocationsUsed: 8,
        contentsCount: 3,
        createdAt: NOW_SECONDS - 1200,
      }),
    );
    expect(used.invocationsUsed).toBe(8);

    const expiring = parseCacheMetadata(
      activeInput({
        cacheName:
          'projects/123/locations/us-central1/cachedContents/expiring789',
        expireTime: NOW_SECONDS + 60,
        fingerprint: 'expiring_fingerprint',
        invocationsUsed: 15,
        contentsCount: 10,
      }),
    );
    expect(expireSoon(expiring)).toBe(true);
  });

  it('test_cache_name_extraction', () => {
    const metadata = parseCacheMetadata(
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
    // Token counts belong on LlmResponse.usageMetadata, so the parser must
    // reject each of them rather than carry it.
    for (const field of ['cachedTokens', 'totalTokens', 'promptTokens']) {
      expect(() =>
        parseCacheMetadata(activeInput({[field]: 100})),
      ).toThrowError(InputValidationError);
    }
  });

  it('test_missing_required_fields', () => {
    expect(() => parseCacheMetadata({contentsCount: 2})).toThrowError(
      InputValidationError,
    );
    expect(() => parseCacheMetadata({fingerprint: 'abc123'})).toThrowError(
      InputValidationError,
    );

    const metadata = parseCacheMetadata({
      fingerprint: 'abc123',
      contentsCount: 5,
    });
    expect(metadata.cacheName).toBeUndefined();
    expect(metadata.expireTime).toBeUndefined();
    expect(metadata.invocationsUsed).toBeUndefined();
    expect(metadata.createdAt).toBeUndefined();
  });

  it('test_partial_active_state_rejected', () => {
    const partials: Array<Record<string, unknown>> = [
      {
        cacheName: 'projects/123/locations/us-central1/cachedContents/x',
        fingerprint: 'abc',
        contentsCount: 1,
      },
      {
        cacheName: 'projects/123/locations/us-central1/cachedContents/x',
        expireTime: NOW_SECONDS + 1800,
        fingerprint: 'abc',
        contentsCount: 1,
      },
      {fingerprint: 'abc', invocationsUsed: 3, contentsCount: 1},
    ];

    for (const partial of partials) {
      expect(() => parseCacheMetadata(partial)).toThrowError(/must all be set/);
    }
  });
});
