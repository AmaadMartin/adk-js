/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {TtlLruCache} from '../../src/utils/ttl_lru_cache.js';

const TTL_SECONDS = 60;
const TTL_MILLIS = TTL_SECONDS * 1000;

describe('TtlLruCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('time to live', () => {
    it('returns a value stored within the lifetime', () => {
      const cache = new TtlLruCache<string>(TTL_SECONDS, 8);
      cache.set('a', 'value');

      vi.advanceTimersByTime(TTL_MILLIS - 1);

      expect(cache.get('a')).toBe('value');
    });

    it('misses, and drops the entry, once the lifetime passes', () => {
      const cache = new TtlLruCache<string>(TTL_SECONDS, 8);
      cache.set('a', 'value');

      vi.advanceTimersByTime(TTL_MILLIS);

      expect(cache.get('a')).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it('misses on a key that was never stored', () => {
      const cache = new TtlLruCache<string>(TTL_SECONDS, 8);

      expect(cache.get('absent')).toBeUndefined();
    });

    it('restarts the lifetime when a key is written again', () => {
      const cache = new TtlLruCache<string>(TTL_SECONDS, 8);
      cache.set('a', 'first');

      vi.advanceTimersByTime(TTL_MILLIS - 1);
      cache.set('a', 'second');
      vi.advanceTimersByTime(TTL_MILLIS - 1);

      expect(cache.get('a')).toBe('second');
    });
  });

  describe('entry cap', () => {
    it('holds no more than maxEntries live keys', () => {
      const maxEntries = 4;
      const cache = new TtlLruCache<number>(TTL_SECONDS, maxEntries);

      for (let i = 0; i < maxEntries + 10; i++) {
        cache.set(`key-${i}`, i);
      }

      expect(cache.size).toBe(maxEntries);
    });

    it('evicts the least recently used key, not the oldest one', () => {
      const cache = new TtlLruCache<string>(TTL_SECONDS, 3);
      cache.set('kept', 'value');
      cache.set('filler-1', 'value');
      cache.set('filler-2', 'value');

      // Reading 'kept' makes it the most recently used entry.
      expect(cache.get('kept')).toBe('value');
      cache.set('filler-3', 'value');
      cache.set('filler-4', 'value');

      expect(cache.get('kept')).toBe('value');
      expect(cache.get('filler-1')).toBeUndefined();
    });
  });

  describe('clear', () => {
    it('empties the cache', () => {
      const cache = new TtlLruCache<string>(TTL_SECONDS, 8);
      cache.set('a', 'value');
      cache.set('b', 'value');

      cache.clear();

      expect(cache.size).toBe(0);
      expect(cache.get('a')).toBeUndefined();
    });
  });
});
