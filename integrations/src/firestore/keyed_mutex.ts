/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** One key's queue: the promise the next caller waits on, and its users. */
interface Waitlist {
  /** Resolves when the caller currently at the back of the queue releases. */
  tail: Promise<void>;
  /** How many callers hold or wait for this key. */
  users: number;
}

/**
 * Runs tasks one at a time per key, within this process.
 *
 * A read-modify-write against a shared record has to be serialized even when
 * the store itself is transactional: two concurrent attempts would otherwise
 * spend a full round trip each before one of them loses the race. Keying the
 * queue means unrelated records never wait on each other.
 *
 * The queue for a key is discarded once its last user leaves, so a long-lived
 * process does not accumulate one entry per key it has ever touched.
 */
export class KeyedMutex {
  private readonly waitlists = new Map<string, Waitlist>();

  /** How many keys are currently held or waited on. */
  get size(): number {
    return this.waitlists.size;
  }

  /**
   * Runs `task` once every earlier caller for `key` has finished.
   *
   * @param key The key to serialize on.
   * @param task The work to run while holding the key.
   * @return Whatever `task` resolves to. A rejection releases the key and
   *   propagates unchanged.
   */
  async runExclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const waitlist = this.waitlists.get(key) ?? {
      tail: Promise.resolve(),
      users: 0,
    };
    waitlist.users++;
    this.waitlists.set(key, waitlist);

    const predecessor = waitlist.tail;
    let release!: () => void;
    waitlist.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await predecessor;
    try {
      return await task();
    } finally {
      release();
      waitlist.users--;
      if (waitlist.users === 0) {
        this.waitlists.delete(key);
      }
    }
  }
}
