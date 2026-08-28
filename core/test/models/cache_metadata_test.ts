/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createCacheMetadata} from '@google/adk';
import {describe, expect, it} from 'vitest';

const ACTIVE_STATE_ERROR =
  'cacheName, expireTime, and invocationsUsed must all be set (active cache) ' +
  'or all be undefined (fingerprint-only state)';

const CACHE_NAME =
  'projects/test/locations/us-central1/cachedContents/test-cache';

describe('createCacheMetadata', () => {
  it('should accept a fully populated active record', () => {
    expect(
      createCacheMetadata({
        cacheName: CACHE_NAME,
        expireTime: 1800,
        fingerprint: 'test_fingerprint',
        invocationsUsed: 5,
        contentsCount: 3,
        createdAt: 600,
      }),
    ).toEqual({
      cacheName: CACHE_NAME,
      expireTime: 1800,
      fingerprint: 'test_fingerprint',
      invocationsUsed: 5,
      contentsCount: 3,
      createdAt: 600,
    });
  });

  it('should accept a fingerprint-only record', () => {
    expect(
      createCacheMetadata({fingerprint: 'test_fingerprint', contentsCount: 2}),
    ).toEqual({fingerprint: 'test_fingerprint', contentsCount: 2});
  });

  it('should return a copy rather than the params object', () => {
    const params = {fingerprint: 'test_fingerprint', contentsCount: 2};
    expect(createCacheMetadata(params)).not.toBe(params);
  });

  it('should accept zero counts', () => {
    expect(
      createCacheMetadata({fingerprint: 'f', contentsCount: 0}).contentsCount,
    ).toBe(0);
  });

  describe('active-state invariant', () => {
    it('should reject cacheName without expireTime and invocationsUsed', () => {
      expect(() =>
        createCacheMetadata({
          cacheName: CACHE_NAME,
          fingerprint: 'f',
          contentsCount: 1,
        }),
      ).toThrow(ACTIVE_STATE_ERROR);
    });

    it('should reject expireTime without cacheName and invocationsUsed', () => {
      expect(() =>
        createCacheMetadata({
          expireTime: 1800,
          fingerprint: 'f',
          contentsCount: 1,
        }),
      ).toThrow(ACTIVE_STATE_ERROR);
    });

    it('should reject invocationsUsed without cacheName and expireTime', () => {
      expect(() =>
        createCacheMetadata({
          invocationsUsed: 1,
          fingerprint: 'f',
          contentsCount: 1,
        }),
      ).toThrow(ACTIVE_STATE_ERROR);
    });

    it('should reject an active record missing only invocationsUsed', () => {
      expect(() =>
        createCacheMetadata({
          cacheName: CACHE_NAME,
          expireTime: 1800,
          fingerprint: 'f',
          contentsCount: 1,
        }),
      ).toThrow(ACTIVE_STATE_ERROR);
    });
  });

  describe('bounds', () => {
    it('should reject a negative invocationsUsed', () => {
      expect(() =>
        createCacheMetadata({
          cacheName: CACHE_NAME,
          expireTime: 1800,
          invocationsUsed: -1,
          fingerprint: 'f',
          contentsCount: 1,
        }),
      ).toThrow('invocationsUsed must be greater than or equal to 0.');
    });

    it('should reject a negative contentsCount', () => {
      expect(() =>
        createCacheMetadata({fingerprint: 'f', contentsCount: -1}),
      ).toThrow('contentsCount must be greater than or equal to 0.');
    });
  });
});
