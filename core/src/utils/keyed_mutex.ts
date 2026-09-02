/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Serializes asynchronous work per string key within one process.
 *
 * Callers that pass the same key run one at a time, in the order they called
 * `runExclusive`. Callers that pass different keys run concurrently. Each key
 * is reference counted, so the internal map drains once every caller for that
 * key settles and a long-lived service does not accumulate one entry per key
 * it has ever seen.
 */
export class KeyedMutex {
  /** The promise the next caller for a key must wait on. */
  private readonly tails = new Map<string, Promise<void>>();
  /** How many callers currently hold or await each key. */
  private readonly waiters = new Map<string, number>();

  /**
   * The number of keys currently held or awaited.
   *
   * Zero once every caller has settled, which is the invariant that keeps the
   * mutex from leaking memory.
   */
  get size(): number {
    return this.tails.size;
  }

  /**
   * Runs `fn` with exclusive access to `key`.
   *
   * @param key The key to serialize on.
   * @param fn The work to run once the key is free.
   * @returns What `fn` resolves to. A rejection from `fn` propagates, and the
   *     key is released either way.
   */
  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(
      key,
      predecessor.then(() => held),
    );
    this.waiters.set(key, (this.waiters.get(key) ?? 0) + 1);

    await predecessor;
    try {
      return await fn();
    } finally {
      release();
      this.releaseKey(key);
    }
  }

  private releaseKey(key: string): void {
    // `runExclusive` counts the caller in before it can reach its `finally`.
    const remaining = this.waiters.get(key)! - 1;
    if (remaining > 0) {
      this.waiters.set(key, remaining);
      return;
    }
    this.waiters.delete(key);
    this.tails.delete(key);
  }
}
