/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runs `task` over every item, with at most `limit` of them running at once.
 *
 * The results come back in input order. Each one is settled rather than
 * thrown, so a single failing item does not cancel the rest.
 *
 * @param items The items to run the task over. An empty list starts no work.
 * @param limit The maximum number of tasks in flight at once.
 * @param task The work to do for one item.
 * @throws {RangeError} When `limit` is less than 1.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  if (limit < 1) {
    throw new RangeError(`limit must be at least 1, got ${limit}.`);
  }

  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = {
          status: 'fulfilled',
          value: await task(items[index], index),
        };
      } catch (error) {
        results[index] = {status: 'rejected', reason: error};
      }
    }
  };

  await Promise.all(
    Array.from({length: Math.min(limit, items.length)}, worker),
  );
  return results;
}

/**
 * Runs `run` over `items` with at most `limit` tasks in flight, yielding each
 * result as it settles rather than in input order.
 *
 * A task is started only when a slot frees up, so a consumer that stops
 * iterating early leaves the remaining items untouched.
 *
 * @param items The items to process. An empty list starts nothing.
 * @param limit Maximum tasks in flight. A value below 1 is read as 1.
 * @param run Starts the task for one item.
 * @yields Each result, in completion order.
 * @throws Whatever the first rejecting task rejected with.
 */
export async function* mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  const maxInFlight = Math.max(1, limit);
  const inFlight = new Map<number, Promise<{index: number; result: R}>>();
  let nextIndex = 0;

  try {
    while (nextIndex < items.length || inFlight.size > 0) {
      while (nextIndex < items.length && inFlight.size < maxInFlight) {
        const index = nextIndex++;
        inFlight.set(
          index,
          run(items[index]).then((result) => ({index, result})),
        );
      }
      const settled = await Promise.race(inFlight.values());
      inFlight.delete(settled.index);
      yield settled.result;
    }
  } finally {
    // A task started before `run` threw on the next item has not reached
    // `Promise.race` yet, so nothing has claimed its rejection. `Promise.race`
    // claims every task it does reach.
    for (const task of inFlight.values()) {
      task.catch(() => {});
    }
  }
}
