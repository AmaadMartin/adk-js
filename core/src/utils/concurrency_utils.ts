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
