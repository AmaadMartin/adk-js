/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs `fn` over `items` with at most `limit` concurrent executions, yielding
 * each result as soon as it settles (completion order, not input order).
 *
 * The first rejection is propagated to the consumer; in-flight siblings are
 * abandoned but never surface as unhandled rejections.
 *
 * @param items The inputs to map over.
 * @param limit The most executions to have in flight at once. A non-positive
 *     or non-numeric limit is treated as 1.
 * @param fn The operation to run for each item.
 */
export async function* mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  // A comparison against NaN is always false, so `Math.max` would leave the
  // limit NaN and silently starve the pool; treat any non-positive or
  // non-numeric limit as 1.
  const effectiveLimit = limit >= 1 ? Math.floor(limit) : 1;
  type Settled =
    | {index: number; ok: true; result: R}
    | {index: number; ok: false; error: unknown};
  const executing = new Map<number, Promise<Settled>>();
  let nextIndex = 0;

  const startNext = (): void => {
    const index = nextIndex++;
    const promise = fn(items[index]).then(
      (result): Settled => ({index, ok: true, result}),
      (error): Settled => ({index, ok: false, error}),
    );
    executing.set(index, promise);
  };

  while (nextIndex < items.length && executing.size < effectiveLimit) {
    startNext();
  }

  while (executing.size > 0) {
    const settled = await Promise.race(executing.values());
    executing.delete(settled.index);
    if (!settled.ok) {
      throw settled.error;
    }
    if (nextIndex < items.length) {
      startNext();
    }
    yield settled.result;
  }
}
