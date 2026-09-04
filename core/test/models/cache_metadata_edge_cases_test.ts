/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  expireSoon,
  formatCacheMetadata,
  parseCacheMetadata,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const NOW_SECONDS = 1_700_000_000;

const CACHE_NAME = 'projects/123/locations/us-central1/cachedContents/456';

function activeInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cacheName: CACHE_NAME,
    expireTime: NOW_SECONDS + 1800,
    fingerprint: 'abcdef0123456789',
    invocationsUsed: 5,
    contentsCount: 3,
    ...overrides,
  };
}

describe('expireSoon at the buffer boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_SECONDS * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
    ).toThrowError(/^fingerprint: /);
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
