/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

interface LockEntry {
  /** Resolves once the last caller queued on this key has finished. */
  tail: Promise<void>;
  /** Callers currently holding or waiting on this key. */
  refCount: number;
}

/**
 * A map of per-key mutexes that serializes async work sharing a key.
 *
 * Entries are reference counted and removed once the last caller releases, so
 * a long-lived process does not accumulate one entry per key it has ever
 * locked.
 */
export class SessionLockMap {
  private readonly entries = new Map<string, LockEntry>();

  /**
   * Runs `fn` with exclusive access to `key`.
   *
   * Callers sharing a key run one at a time, in the order they called; callers
   * with different keys are unaffected.
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    // Python's equivalent needs a guard mutex because another task can
    // interleave at an await. This lookup-and-insert has no await, so it is
    // already atomic.
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {tail: Promise.resolve(), refCount: 0};
      this.entries.set(key, entry);
    }
    entry.refCount++;

    const predecessor = entry.tail;
    let release!: () => void;
    entry.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await predecessor;
    try {
      return await fn();
    } finally {
      release();
      entry.refCount--;
      // Deleting unconditionally would let a queued waiter run against a lock
      // no later caller can see.
      if (entry.refCount === 0) {
        this.entries.delete(key);
      }
    }
  }

  /** Number of live lock entries. Zero once every caller has released. */
  get size(): number {
    return this.entries.size;
  }
}
