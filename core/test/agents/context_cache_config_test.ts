/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {contextCacheTtlString, createContextCacheConfig} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('createContextCacheConfig', () => {
  it('applies the adk-python defaults', () => {
    expect(createContextCacheConfig()).toEqual({
      cacheIntervals: 10,
      ttlSeconds: 1800,
      minTokens: 0,
    });
  });

  it('keeps the values it is given', () => {
    const config = createContextCacheConfig({
      cacheIntervals: 1,
      ttlSeconds: 60,
      minTokens: 2048,
    });

    expect(config).toEqual({
      cacheIntervals: 1,
      ttlSeconds: 60,
      minTokens: 2048,
    });
  });

  it('passes createHttpOptions through', () => {
    const config = createContextCacheConfig({
      createHttpOptions: {timeout: 10000},
    });

    expect(config.createHttpOptions).toEqual({timeout: 10000});
  });

  it('rejects a cacheIntervals below the minimum', () => {
    expect(() => createContextCacheConfig({cacheIntervals: 0})).toThrowError(
      'cacheIntervals must be between 1 and 100.',
    );
  });

  it('rejects a cacheIntervals above the maximum', () => {
    expect(() => createContextCacheConfig({cacheIntervals: 101})).toThrowError(
      'cacheIntervals must be between 1 and 100.',
    );
  });

  it('accepts both ends of the cacheIntervals range', () => {
    expect(createContextCacheConfig({cacheIntervals: 100}).cacheIntervals).toBe(
      100,
    );
    expect(createContextCacheConfig({cacheIntervals: 1}).cacheIntervals).toBe(
      1,
    );
  });

  it('rejects a ttlSeconds of zero', () => {
    expect(() => createContextCacheConfig({ttlSeconds: 0})).toThrowError(
      'ttlSeconds must be at least 1.',
    );
  });

  it('rejects a negative minTokens', () => {
    expect(() => createContextCacheConfig({minTokens: -1})).toThrowError(
      'minTokens must be at least 0.',
    );
  });
});

describe('contextCacheTtlString', () => {
  it('renders the default ttl as a duration string', () => {
    expect(contextCacheTtlString(createContextCacheConfig())).toBe('1800s');
  });

  it('renders a configured ttl', () => {
    expect(
      contextCacheTtlString(createContextCacheConfig({ttlSeconds: 60})),
    ).toBe('60s');
  });
});
