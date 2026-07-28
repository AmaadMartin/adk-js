/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CacheMetadata,
  cacheExpireSoon,
  cacheMetadataToString,
  createCacheMetadata,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const CACHE_NAME = 'projects/123/locations/us-central1/cachedContents/456';
const nowSeconds = () => Date.now() / 1000;

describe('CacheMetadata', () => {
  describe('createCacheMetadata', () => {
    it('creates an active record with all fields', () => {
      const expireTime = nowSeconds() + 1800;
      const meta = createCacheMetadata({
        cacheName: CACHE_NAME,
        expireTime,
        fingerprint: 'abc123',
        invocationsUsed: 5,
        contentsCount: 3,
      });

      expect(meta.cacheName).toBe(CACHE_NAME);
      expect(meta.expireTime).toBe(expireTime);
      expect(meta.fingerprint).toBe('abc123');
      expect(meta.invocationsUsed).toBe(5);
      expect(meta.contentsCount).toBe(3);
      expect(meta.createdAt).toBeUndefined();
    });

    it('accepts an optional createdAt', () => {
      const createdAt = nowSeconds();
      const meta = createCacheMetadata({
        cacheName: CACHE_NAME,
        expireTime: nowSeconds() + 1800,
        fingerprint: 'abc123',
        invocationsUsed: 3,
        contentsCount: 2,
        createdAt,
      });
      expect(meta.createdAt).toBe(createdAt);
    });

    it('creates a fingerprint-only record when active fields are all undefined', () => {
      const meta = createCacheMetadata({
        fingerprint: 'abc123',
        contentsCount: 5,
      });
      expect(meta.cacheName).toBeUndefined();
      expect(meta.expireTime).toBeUndefined();
      expect(meta.invocationsUsed).toBeUndefined();
      expect(meta.createdAt).toBeUndefined();
      expect(meta.fingerprint).toBe('abc123');
      expect(meta.contentsCount).toBe(5);
    });

    it('accepts invocationsUsed and contentsCount boundary values', () => {
      const zero = createCacheMetadata({
        cacheName: CACHE_NAME,
        expireTime: nowSeconds() + 1800,
        fingerprint: 'abc123',
        invocationsUsed: 0,
        contentsCount: 0,
      });
      expect(zero.invocationsUsed).toBe(0);
      expect(zero.contentsCount).toBe(0);
    });

    it('rejects negative invocationsUsed', () => {
      expect(() =>
        createCacheMetadata({
          cacheName: CACHE_NAME,
          expireTime: nowSeconds() + 1800,
          fingerprint: 'abc123',
          invocationsUsed: -1,
          contentsCount: 1,
        }),
      ).toThrow(/invocationsUsed must be greater than or equal to 0/);
    });

    it('rejects negative contentsCount', () => {
      expect(() =>
        createCacheMetadata({
          fingerprint: 'abc123',
          contentsCount: -1,
        }),
      ).toThrow(/contentsCount must be greater than or equal to 0/);
    });

    it('rejects a partial active state (only cacheName set)', () => {
      expect(() =>
        createCacheMetadata({
          cacheName: CACHE_NAME,
          fingerprint: 'abc',
          contentsCount: 1,
        }),
      ).toThrow(/must all be set/);
    });

    it('rejects a partial active state (cacheName + expireTime, no invocationsUsed)', () => {
      expect(() =>
        createCacheMetadata({
          cacheName: CACHE_NAME,
          expireTime: nowSeconds() + 1800,
          fingerprint: 'abc',
          contentsCount: 1,
        }),
      ).toThrow(/must all be set/);
    });

    it('rejects a partial active state (invocationsUsed without cacheName)', () => {
      expect(() =>
        createCacheMetadata({
          fingerprint: 'abc',
          invocationsUsed: 3,
          contentsCount: 1,
        }),
      ).toThrow(/must all be set/);
    });

    it('returns an immutable (frozen) record', () => {
      const meta = createCacheMetadata({
        cacheName: CACHE_NAME,
        expireTime: nowSeconds() + 1800,
        fingerprint: 'abc123',
        invocationsUsed: 5,
        contentsCount: 3,
      });
      expect(Object.isFrozen(meta)).toBe(true);
      expect(() => {
        (meta as CacheMetadata).invocationsUsed = 10;
      }).toThrow();
    });
  });

  describe('cacheExpireSoon', () => {
    it('is false for a cache expiring well in the future', () => {
      const meta = createCacheMetadata({
        cacheName: CACHE_NAME,
        expireTime: nowSeconds() + 600,
        fingerprint: 'abc123',
        invocationsUsed: 1,
        contentsCount: 1,
      });
      expect(cacheExpireSoon(meta)).toBe(false);
    });

    it('is true within the 2-minute buffer', () => {
      const meta = createCacheMetadata({
        cacheName: CACHE_NAME,
        expireTime: nowSeconds() + 60,
        fingerprint: 'abc123',
        invocationsUsed: 1,
        contentsCount: 1,
      });
      expect(cacheExpireSoon(meta)).toBe(true);
    });

    it('is false when there is no expireTime (fingerprint-only)', () => {
      const meta = createCacheMetadata({
        fingerprint: 'abc123',
        contentsCount: 1,
      });
      expect(cacheExpireSoon(meta)).toBe(false);
    });
  });

  describe('cacheMetadataToString', () => {
    it('renders the active-cache format with the extracted cache id', () => {
      const meta = createCacheMetadata({
        cacheName:
          'projects/123/locations/us-central1/cachedContents/extracted_id',
        expireTime: nowSeconds() + 1800,
        fingerprint: 'abc123',
        invocationsUsed: 7,
        contentsCount: 4,
      });
      const rendered = cacheMetadataToString(meta);
      expect(rendered).toContain('extracted_id');
      expect(rendered).toContain('used 7 invocations');
      expect(rendered).toContain('cached 4 contents');
      expect(rendered).toContain('expires in');
    });

    it('renders the fingerprint-only format', () => {
      const meta = createCacheMetadata({
        fingerprint: 'abcdef0123456789',
        contentsCount: 2,
      });
      const rendered = cacheMetadataToString(meta);
      expect(rendered).toContain('Fingerprint-only: 2 contents');
      expect(rendered).toContain('fingerprint=abcdef01...');
    });
  });
});
