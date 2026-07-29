/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createContextCacheConfig} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('ContextCacheConfig', () => {
  it('applies defaults when no options are provided', () => {
    const config = createContextCacheConfig();

    expect(config.cacheIntervals).toBe(10);
    expect(config.ttlSeconds).toBe(1800);
    expect(config.minTokens).toBe(0);
    expect(config.createHttpOptions).toBeUndefined();
  });

  it('uses provided option values', () => {
    const createHttpOptions = {timeout: 10000};
    const config = createContextCacheConfig({
      cacheIntervals: 5,
      ttlSeconds: 600,
      minTokens: 2048,
      createHttpOptions,
    });

    expect(config.cacheIntervals).toBe(5);
    expect(config.ttlSeconds).toBe(600);
    expect(config.minTokens).toBe(2048);
    expect(config.createHttpOptions).toBe(createHttpOptions);
  });

  it('accepts the boundary values', () => {
    expect(() => createContextCacheConfig({cacheIntervals: 1})).not.toThrow();
    expect(() => createContextCacheConfig({cacheIntervals: 100})).not.toThrow();
    expect(() => createContextCacheConfig({ttlSeconds: 1})).not.toThrow();
  });

  it('rejects out-of-range cacheIntervals', () => {
    expect(() => createContextCacheConfig({cacheIntervals: 0})).toThrow(
      /cacheIntervals must be between 1 and 100/,
    );
    expect(() => createContextCacheConfig({cacheIntervals: 101})).toThrow(
      /cacheIntervals must be between 1 and 100/,
    );
  });

  it('rejects a non-positive ttlSeconds', () => {
    expect(() => createContextCacheConfig({ttlSeconds: 0})).toThrow(
      /ttlSeconds must be greater than 0/,
    );
  });

  it('rejects a negative minTokens', () => {
    expect(() => createContextCacheConfig({minTokens: -1})).toThrow(
      /minTokens must be at least 0/,
    );
  });
});
