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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SECONDS * 1000);
});

afterEach(() => {
  vi.useRealTimers();
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

/**
 * Ported from adk-python `tests/unittests/models/test_cache_metadata.py`,
 * branch `main`, commit 76b9f0baa0bcc4e715ee996b4dc894ffc9264583.
 *
 * The Python names are kept verbatim so a reader can grep the original. 13 of
 * the 14 reference tests are ported; `test_field_descriptions` reads a pydantic
 * JSON schema that this module has no counterpart for.
 */
describe('cache_metadata parity with adk-python', () => {
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

describe('expireSoon at the buffer boundary', () => {
  it('reports false for fingerprint-only metadata', () => {
    const metadata = parseCacheMetadata({
      fingerprint: 'abcdef0123456789',
      contentsCount: 3,
    });

    expect(expireSoon(metadata)).toBe(false);
  });

  it('reports false one second outside the buffer', () => {
    const metadata = parseCacheMetadata(
      activeInput({expireTime: NOW_SECONDS + 121}),
    );

    expect(expireSoon(metadata)).toBe(false);
  });

  it('reports true one second inside the buffer', () => {
    const metadata = parseCacheMetadata(
      activeInput({expireTime: NOW_SECONDS + 119}),
    );

    expect(expireSoon(metadata)).toBe(true);
  });
});

describe('formatCacheMetadata rendering', () => {
  it('truncates the fingerprint to eight characters', () => {
    const metadata = parseCacheMetadata({
      fingerprint: 'abcdef0123456789',
      contentsCount: 3,
    });

    expect(formatCacheMetadata(metadata)).toBe(
      'Fingerprint-only: 3 contents, fingerprint=abcdef01...',
    );
  });

  it('renders a fingerprint shorter than eight characters whole', () => {
    const metadata = parseCacheMetadata({
      fingerprint: 'abc',
      contentsCount: 1,
    });

    expect(formatCacheMetadata(metadata)).toBe(
      'Fingerprint-only: 1 contents, fingerprint=abc...',
    );
  });

  it('renders a cache name that has no slash as itself', () => {
    const metadata = parseCacheMetadata(
      activeInput({cacheName: 'bare-name', expireTime: NOW_SECONDS + 1800}),
    );

    expect(formatCacheMetadata(metadata)).toBe(
      'Cache bare-name: used 5 invocations, cached 3 contents, ' +
        'expires in 30.0min',
    );
  });

  it('renders a negative minute count for an expired cache', () => {
    const metadata = parseCacheMetadata(
      activeInput({expireTime: NOW_SECONDS - 192}),
    );

    expect(formatCacheMetadata(metadata)).toBe(
      'Cache 456: used 5 invocations, cached 3 contents, expires in -3.2min',
    );
  });
});

describe('parseCacheMetadata rejections', () => {
  it('rejects a fractional contentsCount', () => {
    expect(() =>
      parseCacheMetadata(activeInput({contentsCount: 1.5})),
    ).toThrowError(
      new InputValidationError('contentsCount must be a non-negative integer.'),
    );
  });

  it('rejects a fractional invocationsUsed', () => {
    expect(() =>
      parseCacheMetadata(activeInput({invocationsUsed: 2.5})),
    ).toThrowError(
      new InputValidationError(
        'invocationsUsed must be a non-negative integer.',
      ),
    );
  });

  it('names the offending field on a wrong type', () => {
    expect(() =>
      parseCacheMetadata(activeInput({fingerprint: 42})),
    ).toThrowError(new InputValidationError('fingerprint must be a string.'));
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an array', []],
    ['undefined', undefined],
  ])('rejects %s with InputValidationError', (_label, value) => {
    expect(() => parseCacheMetadata(value)).toThrowError(InputValidationError);
  });

  it('rejects every partial combination of the active fields', () => {
    const base = {fingerprint: 'abcdef0123456789', contentsCount: 3};
    const active: Record<string, unknown> = {
      cacheName: CACHE_NAME,
      expireTime: NOW_SECONDS + 1800,
      invocationsUsed: 5,
    };
    const names = Object.keys(active);

    // Every non-empty proper subset of the three active fields.
    for (let mask = 1; mask < 7; mask++) {
      const partial: Record<string, unknown> = {...base};
      names.forEach((name, index) => {
        if ((mask & (1 << index)) !== 0) {
          partial[name] = active[name];
        }
      });
      expect(() => parseCacheMetadata(partial)).toThrowError(/must all be set/);
    }
  });

  it('drops nothing from an accepted record', () => {
    const metadata = parseCacheMetadata(
      activeInput({createdAt: NOW_SECONDS - 60}),
    );

    expect(Object.keys(metadata).sort()).toEqual([
      'cacheName',
      'contentsCount',
      'createdAt',
      'expireTime',
      'fingerprint',
      'invocationsUsed',
    ]);
  });
});
