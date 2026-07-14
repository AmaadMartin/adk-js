/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  createContextCacheConfig,
  getTtlString,
} from '../../src/agents/context_cache_config.js';
import {createCacheMetadata} from '../../src/models/cache_metadata.js';

describe('ContextCacheConfig', () => {
  describe('createContextCacheConfig', () => {
    it('creates a config with default values when no params provided', () => {
      const config = createContextCacheConfig();
      expect(config).toEqual({
        cacheIntervals: 10,
        ttlSeconds: 1800,
        minTokens: 0,
      });
    });

    it('overrides defaults when partial params are provided', () => {
      const config = createContextCacheConfig({
        cacheIntervals: 5,
        ttlSeconds: 3600,
        minTokens: 4096,
      });
      expect(config).toEqual({
        cacheIntervals: 5,
        ttlSeconds: 3600,
        minTokens: 4096,
      });
    });

    it('throws when cacheIntervals is less than 1', () => {
      expect(() => createContextCacheConfig({cacheIntervals: 0})).toThrow(
        'cacheIntervals must be between 1 and 100 inclusive.',
      );
    });

    it('throws when cacheIntervals is greater than 100', () => {
      expect(() => createContextCacheConfig({cacheIntervals: 101})).toThrow(
        'cacheIntervals must be between 1 and 100 inclusive.',
      );
    });

    it('throws when ttlSeconds is less than or equal to 0', () => {
      expect(() => createContextCacheConfig({ttlSeconds: 0})).toThrow(
        'ttlSeconds must be greater than 0.',
      );
      expect(() => createContextCacheConfig({ttlSeconds: -10})).toThrow(
        'ttlSeconds must be greater than 0.',
      );
    });

    it('throws when minTokens is less than 0', () => {
      expect(() => createContextCacheConfig({minTokens: -1})).toThrow(
        'minTokens must be greater than or equal to 0.',
      );
    });
  });

  describe('getTtlString', () => {
    it('returns formatted ttl string', () => {
      const config = createContextCacheConfig({ttlSeconds: 600});
      expect(getTtlString(config)).toBe('600s');
    });

    it('uses default 1800s if ttlSeconds is undefined on object', () => {
      expect(getTtlString({})).toBe('1800s');
    });
  });
});

describe('CacheMetadata', () => {
  describe('createCacheMetadata', () => {
    it('creates active cache metadata when all 3 active fields are set', () => {
      const meta = createCacheMetadata({
        cacheName: 'projects/123/locations/us-central1/cachedContents/456',
        expireTime: 1700000000,
        fingerprint: 'hash_123',
        invocationsUsed: 1,
        contentsCount: 5,
        createdAt: 1699990000,
      });
      expect(meta.cacheName).toBe(
        'projects/123/locations/us-central1/cachedContents/456',
      );
      expect(meta.expireTime).toBe(1700000000);
      expect(meta.invocationsUsed).toBe(1);
    });

    it('creates fingerprint-only state when cacheName, expireTime, and invocationsUsed are undefined', () => {
      const meta = createCacheMetadata({
        fingerprint: 'hash_456',
        contentsCount: 10,
      });
      expect(meta.cacheName).toBeUndefined();
      expect(meta.expireTime).toBeUndefined();
      expect(meta.invocationsUsed).toBeUndefined();
      expect(meta.fingerprint).toBe('hash_456');
    });

    it('throws error when active state invariant is violated (mixed active fields)', () => {
      expect(() =>
        createCacheMetadata({
          cacheName: 'some_cache',
          fingerprint: 'hash_789',
          contentsCount: 2,
        }),
      ).toThrow(
        'cacheName, expireTime, and invocationsUsed must all be set (active cache) or all be undefined (fingerprint-only state)',
      );
    });
  });
});
