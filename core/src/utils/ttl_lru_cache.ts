/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** A cached value and the wall-clock time it stops being usable. */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * A cache that drops an entry when it expires, and drops the least recently
 * used entry when it is full.
 *
 * Both limits matter. The time to live keeps a stale value from being served
 * forever, and the entry cap keeps a caller that mints a fresh key per request
 * from growing the cache without bound while every entry is still live.
 *
 * A JavaScript `Map` iterates in insertion order, so the least recently used
 * key is the first one it yields, and a read moves its key to the end.
 */
export class TtlLruCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly ttlMillis: number;
  private readonly maxEntries: number;

  constructor(ttlSeconds: number, maxEntries: number) {
    this.ttlMillis = ttlSeconds * 1000;
    this.maxEntries = maxEntries;
  }

  /** The number of entries held, including any that have expired. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Returns the live value stored under `key`, and marks it most recently
   * used.
   *
   * @return The value, or undefined on a miss or an expiry.
   */
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  /** Stores `value` under `key`, evicting the least recently used when full. */
  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, {value, expiresAt: Date.now() + this.ttlMillis});

    while (this.entries.size > this.maxEntries) {
      const [leastRecentlyUsed] = this.entries.keys();
      this.entries.delete(leastRecentlyUsed);
    }
  }

  /** Empties the cache. */
  clear(): void {
    this.entries.clear();
  }
}
