/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createContextCacheConfig} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('createContextCacheConfig', () => {
  it('should apply the adk-python defaults when no params given', () => {
    expect(createContextCacheConfig()).toEqual({
      cacheIntervals: 10,
      ttlSeconds: 1800,
      minTokens: 0,
    });
  });

  it('should keep custom values verbatim', () => {
    expect(
      createContextCacheConfig({
        cacheIntervals: 15,
        ttlSeconds: 3600,
        minTokens: 1024,
      }),
    ).toEqual({cacheIntervals: 15, ttlSeconds: 3600, minTokens: 1024});
  });

  it('should not mutate the params object', () => {
    const params = {cacheIntervals: 15};
    createContextCacheConfig(params);
    expect(params).toEqual({cacheIntervals: 15});
  });

  describe('cacheIntervals validation', () => {
    it('should accept the lower bound 1', () => {
      expect(createContextCacheConfig({cacheIntervals: 1}).cacheIntervals).toBe(
        1,
      );
    });

    it('should accept the upper bound 100', () => {
      expect(
        createContextCacheConfig({cacheIntervals: 100}).cacheIntervals,
      ).toBe(100);
    });

    it('should reject 0', () => {
      expect(() => createContextCacheConfig({cacheIntervals: 0})).toThrow(
        'cacheIntervals must be greater than or equal to 1.',
      );
    });

    it('should reject 101', () => {
      expect(() => createContextCacheConfig({cacheIntervals: 101})).toThrow(
        'cacheIntervals must be less than or equal to 100.',
      );
    });

    it('should reject NaN as a non-integer', () => {
      expect(() => createContextCacheConfig({cacheIntervals: NaN})).toThrow(
        'cacheIntervals must be an integer.',
      );
    });

    it('should report the integer error before the range error', () => {
      expect(() => createContextCacheConfig({cacheIntervals: 0.5})).toThrow(
        'cacheIntervals must be an integer.',
      );
    });
  });

  describe('ttlSeconds validation', () => {
    it('should accept the lower bound 1', () => {
      expect(createContextCacheConfig({ttlSeconds: 1}).ttlSeconds).toBe(1);
    });

    it('should accept 86400', () => {
      expect(createContextCacheConfig({ttlSeconds: 86400}).ttlSeconds).toBe(
        86400,
      );
    });

    it('should reject 0', () => {
      expect(() => createContextCacheConfig({ttlSeconds: 0})).toThrow(
        'ttlSeconds must be greater than 0.',
      );
    });

    it('should reject a negative value', () => {
      expect(() => createContextCacheConfig({ttlSeconds: -1})).toThrow(
        'ttlSeconds must be greater than 0.',
      );
    });

    it('should reject a fractional value', () => {
      expect(() => createContextCacheConfig({ttlSeconds: 1.5})).toThrow(
        'ttlSeconds must be an integer.',
      );
    });
  });

  describe('minTokens validation', () => {
    it('should accept the lower bound 0', () => {
      expect(createContextCacheConfig({minTokens: 0}).minTokens).toBe(0);
    });

    it('should accept 1024', () => {
      expect(createContextCacheConfig({minTokens: 1024}).minTokens).toBe(1024);
    });

    it('should reject a negative value', () => {
      expect(() => createContextCacheConfig({minTokens: -1})).toThrow(
        'minTokens must be greater than or equal to 0.',
      );
    });

    it('should reject a fractional value', () => {
      expect(() => createContextCacheConfig({minTokens: 0.5})).toThrow(
        'minTokens must be an integer.',
      );
    });
  });

  describe('realistic scenarios', () => {
    it('should build a development config', () => {
      expect(
        createContextCacheConfig({
          cacheIntervals: 5,
          ttlSeconds: 600,
          minTokens: 0,
        }),
      ).toEqual({cacheIntervals: 5, ttlSeconds: 600, minTokens: 0});
    });

    it('should build a production config', () => {
      expect(
        createContextCacheConfig({
          cacheIntervals: 20,
          ttlSeconds: 7200,
          minTokens: 2048,
        }),
      ).toEqual({cacheIntervals: 20, ttlSeconds: 7200, minTokens: 2048});
    });

    it('should build a conservative config', () => {
      expect(
        createContextCacheConfig({
          cacheIntervals: 3,
          ttlSeconds: 300,
          minTokens: 4096,
        }),
      ).toEqual({cacheIntervals: 3, ttlSeconds: 300, minTokens: 4096});
    });
  });
});
