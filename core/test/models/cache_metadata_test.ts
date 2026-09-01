/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';

import {cacheExpiresSoon, createCacheMetadata} from '@google/adk';

const ACTIVE_FIELDS = {
  cacheName: 'projects/1/locations/us-central1/cachedContents/2',
  expireTime: 1_800_000,
  invocationsUsed: 3,
};

describe('createCacheMetadata', () => {
  it('accepts the fingerprint-only state', () => {
    const metadata = createCacheMetadata({
      fingerprint: 'abc123',
      contentsCount: 4,
    });

    expect(metadata.cacheName).toBeUndefined();
    expect(metadata.fingerprint).toBe('abc123');
  });

  it('accepts the active-cache state', () => {
    const metadata = createCacheMetadata({
      ...ACTIVE_FIELDS,
      fingerprint: 'abc123',
      contentsCount: 4,
      createdAt: 1_700_000,
    });

    expect(metadata.cacheName).toBe(ACTIVE_FIELDS.cacheName);
    expect(metadata.invocationsUsed).toBe(3);
  });

  it.each([
    ['cacheName', {cacheName: ACTIVE_FIELDS.cacheName}],
    ['expireTime', {expireTime: ACTIVE_FIELDS.expireTime}],
    ['invocationsUsed', {invocationsUsed: ACTIVE_FIELDS.invocationsUsed}],
  ])('rejects %s on its own', (_name, partial) => {
    expect(() =>
      createCacheMetadata({
        fingerprint: 'abc123',
        contentsCount: 1,
        ...partial,
      }),
    ).toThrow(
      'cacheName, expireTime, and invocationsUsed must all be set (active ' +
        'cache) or all be undefined (fingerprint-only state)',
    );
  });

  it('rejects two of the three active fields', () => {
    expect(() =>
      createCacheMetadata({
        cacheName: ACTIVE_FIELDS.cacheName,
        expireTime: ACTIVE_FIELDS.expireTime,
        fingerprint: 'abc123',
        contentsCount: 1,
      }),
    ).toThrow('must all be set');
  });

  it('rejects a negative invocation count', () => {
    expect(() =>
      createCacheMetadata({
        ...ACTIVE_FIELDS,
        invocationsUsed: -1,
        fingerprint: 'abc123',
        contentsCount: 1,
      }),
    ).toThrow('invocationsUsed must not be negative');
  });

  it('rejects a negative contents count', () => {
    expect(() =>
      createCacheMetadata({fingerprint: 'abc123', contentsCount: -1}),
    ).toThrow('contentsCount must not be negative');
  });
});

describe('cacheExpiresSoon', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports no expiry for fingerprint-only metadata', () => {
    expect(cacheExpiresSoon({fingerprint: 'abc123', contentsCount: 1})).toBe(
      false,
    );
  });

  it('reports a far-future expiry as not soon', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000_000));

    expect(
      cacheExpiresSoon({
        ...ACTIVE_FIELDS,
        expireTime: 1_000_000_000 / 1000 + 3600,
        fingerprint: 'abc123',
        contentsCount: 1,
      }),
    ).toBe(false);
  });

  it('reports an expiry inside the buffer as soon', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000_000));

    expect(
      cacheExpiresSoon({
        ...ACTIVE_FIELDS,
        expireTime: 1_000_000_000 / 1000 + 60,
        fingerprint: 'abc123',
        contentsCount: 1,
      }),
    ).toBe(true);
  });
});
