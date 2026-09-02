/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A generic, single-consumer async queue that implements AsyncIterable,
 * bridging a *push* producer to a *pull* consumer (`for await (const x of q)`).
 *
 * Producers call {@link push} as values are produced and {@link close} (or
 * {@link fail}) when finished. A single consumer drains the queue.
 *
 * Semantics:
 *  - Buffered items are always delivered before an end/error signal.
 *  - {@link close} ends iteration cleanly (`done: true`); idempotent.
 *  - {@link fail} surfaces the error to the consumer *after* any buffered items
 *    have been drained; it is sticky (first failure wins) and also closes the
 *    queue, so a later `close()` can't discard the error.
 *  - {@link push} after close/fail is ignored (the producer has already
 *    signalled completion).
 *  - With a `highWaterMark`, a producer that awaits {@link whenDrained} after
 *    each push does not outrun the consumer, so the buffer stays bounded.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private closed = false;
  private failure?: {error: unknown};
  private drainWaiters: Array<() => void> = [];
  private readonly highWaterMark: number;

  /**
   * @param options.highWaterMark How many items may sit in the buffer before
   *   {@link whenDrained} makes a producer wait. Unbounded when omitted.
   */
  constructor(options?: {highWaterMark?: number}) {
    this.highWaterMark = options?.highWaterMark ?? Infinity;
  }

  /** Whether the queue has been closed or failed. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** Number of items buffered and not yet consumed. */
  get size(): number {
    return this.queue.length;
  }

  /**
   * Enqueues a value. If a consumer is currently awaiting, it is resolved
   * immediately; otherwise the value is buffered. No-op once closed/failed.
   */
  push(value: T) {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver.resolve({value, done: false});
    } else {
      this.queue.push(value);
    }
  }

  /**
   * Signals that production failed. Buffered items are still delivered first;
   * once the buffer drains, the consumer's next `next()` rejects with `error`.
   * Sticky (first failure wins) and closes the queue.
   */
  fail(error: unknown) {
    if (this.failure) return;
    this.failure = {error};
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!.reject(error);
    }
    this.releaseDrainWaiters();
  }

  /** @deprecated Alias for {@link fail}; kept for existing callers. */
  error(err: unknown) {
    this.fail(err);
  }

  /**
   * Signals that no more items will be produced. Any awaiting consumer receives
   * `{done: true}`. Idempotent.
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!.resolve({value: undefined as never, done: true});
    }
    this.releaseDrainWaiters();
  }

  /**
   * Resolves once the buffer is under the `highWaterMark`, or at once when
   * there is no mark, when the buffer has room, or when the queue is closed.
   *
   * A producer awaits this after each {@link push} to apply back-pressure. It
   * waits rather than dropping, so nothing is lost.
   */
  whenDrained(): Promise<void> {
    if (this.closed || this.queue.length < this.highWaterMark) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.drainWaiters.push(resolve);
    });
  }

  /** Lets every waiting producer re-check the buffer. */
  private releaseDrainWaiters() {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          if (this.queue.length < this.highWaterMark) {
            this.releaseDrainWaiters();
          }
          return Promise.resolve({value, done: false});
        }
        if (this.failure) {
          return Promise.reject(this.failure.error);
        }
        if (this.closed) {
          return Promise.resolve({value: undefined as never, done: true});
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.resolvers.push({resolve, reject});
        });
      },
    };
  }
}
