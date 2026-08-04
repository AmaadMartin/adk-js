/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A synchronous, single-slot stand-in for `AsyncLocalStorage`, for runtimes
 * without `node:async_hooks` (browsers, most notably).
 *
 * It restores the previous value when `run` returns, so nesting works, but the
 * value lives in one instance field rather than in an async context: it does
 * not survive an `await`, and concurrent `run` calls overwrite each other. It
 * is therefore not an `AsyncLocalStorage` equivalent and must never be used as
 * the Node implementation.
 */
export class AsyncLocalStorage<T> {
  private store: T | undefined;
  run<R>(store: T, callback: () => R): R {
    const previous = this.store;
    this.store = store;
    try {
      return callback();
    } finally {
      this.store = previous;
    }
  }
  getStore(): T | undefined {
    return this.store;
  }
}
