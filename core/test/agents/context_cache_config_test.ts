/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ContextCacheConfig} from '@google/adk';
import {
  DEFAULT_CONTEXT_CACHE_CONFIG,
  contextCacheConfigToString,
  createContextCacheConfig,
  ttlString,
} from '@google/adk';
import type {HttpOptions} from '@google/genai';
import {describe, expect, it} from 'vitest';

describe('ContextCacheConfig', () => {
  describe('createContextCacheConfig', () => {
    it('fills defaults when no values are provided', () => {
      const config = createContextCacheConfig();
      expect(config.cacheIntervals).toBe(10);
      expect(config.ttlSeconds).toBe(1800);
      expect(config.minTokens).toBe(0);
      expect(config.createHttpOptions).toBeUndefined();
    });

    it('fills defaults for omitted fields only', () => {
      const config = createContextCacheConfig({ttlSeconds: 3600});
      expect(config.cacheIntervals).toBe(10);
      expect(config.ttlSeconds).toBe(3600);
      expect(config.minTokens).toBe(0);
    });

    it('preserves custom values', () => {
      const config = createContextCacheConfig({
        cacheIntervals: 15,
        ttlSeconds: 3600,
        minTokens: 1024,
      });
      expect(config.cacheIntervals).toBe(15);
      expect(config.ttlSeconds).toBe(3600);
      expect(config.minTokens).toBe(1024);
    });

    it('preserves createHttpOptions passthrough', () => {
      const httpOptions: HttpOptions = {timeout: 10000};
      const config = createContextCacheConfig({createHttpOptions: httpOptions});
      expect(config.createHttpOptions).toEqual(httpOptions);
    });

    it('returns a frozen configuration', () => {
      const config = createContextCacheConfig();
      expect(Object.isFrozen(config)).toBe(true);
    });

    it('accepts the cacheIntervals boundary values', () => {
      expect(createContextCacheConfig({cacheIntervals: 1}).cacheIntervals).toBe(
        1,
      );
      expect(
        createContextCacheConfig({cacheIntervals: 100}).cacheIntervals,
      ).toBe(100);
    });

    it('rejects out-of-range cacheIntervals', () => {
      expect(() => createContextCacheConfig({cacheIntervals: 0})).toThrow(
        /cacheIntervals must be between 1 and 100/,
      );
      expect(() => createContextCacheConfig({cacheIntervals: 101})).toThrow(
        /cacheIntervals must be between 1 and 100/,
      );
    });

    it('accepts positive ttlSeconds', () => {
      expect(createContextCacheConfig({ttlSeconds: 1}).ttlSeconds).toBe(1);
      expect(createContextCacheConfig({ttlSeconds: 86400}).ttlSeconds).toBe(
        86400,
      );
    });

    it('rejects non-positive ttlSeconds', () => {
      expect(() => createContextCacheConfig({ttlSeconds: 0})).toThrow(
        /ttlSeconds must be greater than 0/,
      );
      expect(() => createContextCacheConfig({ttlSeconds: -1})).toThrow(
        /ttlSeconds must be greater than 0/,
      );
    });

    it('accepts non-negative minTokens', () => {
      expect(createContextCacheConfig({minTokens: 0}).minTokens).toBe(0);
      expect(createContextCacheConfig({minTokens: 1024}).minTokens).toBe(1024);
    });

    it('rejects negative minTokens', () => {
      expect(() => createContextCacheConfig({minTokens: -1})).toThrow(
        /minTokens must be greater than or equal to 0/,
      );
    });

    it('supports realistic dev, prod, and conservative configs', () => {
      const dev = createContextCacheConfig({
        cacheIntervals: 5,
        ttlSeconds: 600,
        minTokens: 0,
      });
      expect(dev.cacheIntervals).toBe(5);
      expect(dev.ttlSeconds).toBe(600);

      const prod = createContextCacheConfig({
        cacheIntervals: 20,
        ttlSeconds: 7200,
        minTokens: 2048,
      });
      expect(prod.cacheIntervals).toBe(20);
      expect(prod.ttlSeconds).toBe(7200);
      expect(prod.minTokens).toBe(2048);

      const conservative = createContextCacheConfig({
        cacheIntervals: 3,
        ttlSeconds: 300,
        minTokens: 4096,
      });
      expect(conservative.cacheIntervals).toBe(3);
      expect(conservative.minTokens).toBe(4096);
    });
  });

  describe('DEFAULT_CONTEXT_CACHE_CONFIG', () => {
    it('exposes the documented defaults and is frozen', () => {
      expect(DEFAULT_CONTEXT_CACHE_CONFIG.cacheIntervals).toBe(10);
      expect(DEFAULT_CONTEXT_CACHE_CONFIG.ttlSeconds).toBe(1800);
      expect(DEFAULT_CONTEXT_CACHE_CONFIG.minTokens).toBe(0);
      expect(Object.isFrozen(DEFAULT_CONTEXT_CACHE_CONFIG)).toBe(true);
    });
  });

  describe('ttlString', () => {
    it('formats the configured ttl as a duration string', () => {
      expect(ttlString({ttlSeconds: 1800})).toBe('1800s');
      expect(ttlString({ttlSeconds: 3600})).toBe('3600s');
    });

    it('falls back to the default ttl when unset', () => {
      expect(ttlString({})).toBe('1800s');
    });
  });

  describe('contextCacheConfigToString', () => {
    it('renders the full field set', () => {
      const config: ContextCacheConfig = {
        cacheIntervals: 15,
        ttlSeconds: 3600,
        minTokens: 1024,
      };
      expect(contextCacheConfigToString(config)).toBe(
        'ContextCacheConfig(cacheIntervals=15, ttl=3600s, minTokens=1024, ' +
          'createHttpOptions=undefined)',
      );
    });

    it('renders defaults for omitted fields', () => {
      expect(contextCacheConfigToString({})).toBe(
        'ContextCacheConfig(cacheIntervals=10, ttl=1800s, minTokens=0, ' +
          'createHttpOptions=undefined)',
      );
    });

    it('includes createHttpOptions when present', () => {
      const rendered = contextCacheConfigToString({
        createHttpOptions: {timeout: 10000},
      });
      expect(rendered).toContain('createHttpOptions=');
      expect(rendered).not.toContain('createHttpOptions=undefined');
    });
  });
});
