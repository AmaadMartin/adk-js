/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A counting semaphore that bounds how many tasks run at once.
 *
 * Waiters are admitted first-in-first-out, so a burst of arrivals cannot
 * starve the request that has been queued longest.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  /**
   * @param permits How many tasks may run at once. Must be a positive integer.
   */
  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new RangeError(
        `Semaphore permits must be a positive integer, got ${permits}.`,
      );
    }
    this.available = permits;
  }

  /**
   * Runs `task` while holding a permit, and releases the permit on every exit
   * path including a rejection.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available++;
  }
}
