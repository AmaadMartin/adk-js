/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns true when `value` is a promise or any other thenable, using the same
 * test the language applies when it decides whether to adopt a value.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === 'object' && value !== null) ||
      typeof value === 'function') &&
    typeof (value as {then?: unknown}).then === 'function'
  );
}

/**
 * Browser stand-in for the `AsyncLocalStorage` class of the `node:async_hooks`
 * builtin, wired up by the alias in `build.js`.
 *
 * A browser has no async context, so this class holds the store in one
 * instance field for the synchronous extent of `run`. That covers a
 * synchronous callback exactly, including nesting and restore-on-throw.
 *
 * It cannot cover a callback that returns a promise: the field is restored
 * when the callback returns its promise, not when that promise settles, so
 * every read after the first `await` would see the previous store. `run`
 * throws for such a callback instead of returning that stale value.
 *
 * One divergence stays undetectable. A synchronous callback that schedules
 * deferred work with `setTimeout`, `queueMicrotask` or a fire-and-forget call
 * returns before the deferred work runs, so that work reads the previous store
 * and this class cannot tell.
 */
export class AsyncLocalStorage<T> {
  private store: T | undefined;

  run<R>(store: T, callback: () => R): R {
    const previous = this.store;
    this.store = store;
    let result: R;
    try {
      result = callback();
    } finally {
      this.store = previous;
    }

    if (isThenable(result)) {
      // The callback keeps running after this throws. Without a handler its
      // failure would surface as an unhandled rejection on top of the error
      // the caller is about to see.
      void Promise.resolve(result).catch(() => {});
      throw new Error(
        'AsyncLocalStorage: this runtime has no async context, so the store ' +
          'does not survive an await. run() requires a synchronous callback.',
      );
    }

    return result;
  }

  getStore(): T | undefined {
    return this.store;
  }
}
