/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A counting semaphore that bounds how many tasks run at the same time.
 *
 * Waiters are admitted in FIFO order. The only entry point is {@link run},
 * which owns the whole acquire/release cycle, so a permit cannot leak when the
 * task rejects.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(
        `Semaphore permits must be a positive integer, got: ${permits}`,
      );
    }
    this.available = permits;
  }

  /** Runs `fn` once a permit is free and releases the permit afterwards. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
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
      // The permit passes straight to the waiter, so `available` stays at 0.
      next();
      return;
    }
    this.available++;
  }
}
