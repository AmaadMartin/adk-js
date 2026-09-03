/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';

/**
 * Applies `fn` to every item, running at most `limit` calls at a time.
 *
 * Results arrive in completion order, not in input order. A caller that needs
 * input order must collect the results itself.
 *
 * A call that is already running keeps running after the consumer stops
 * reading, because a promise cannot be cancelled. Its result is dropped, and
 * so is its failure.
 *
 * @param items The items to map.
 * @param limit How many calls may run at a time.
 * @param fn The call to apply to one item.
 * @throws {InputValidationError} When `limit` is not an integer of at least 1.
 */
export async function* mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): AsyncGenerator<R> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InputValidationError(
      `Concurrency limit must be an integer of at least 1, got ${limit}.`,
    );
  }

  const inFlight = new Map<number, Promise<{key: number; value: R}>>();
  let nextIndex = 0;

  const startNext = () => {
    const key = nextIndex++;
    inFlight.set(
      key,
      fn(items[key]).then((value) => ({key, value})),
    );
  };

  try {
    while (nextIndex < items.length && inFlight.size < limit) {
      startNext();
    }
    while (inFlight.size > 0) {
      const {key, value} = await Promise.race(inFlight.values());
      inFlight.delete(key);
      if (nextIndex < items.length) {
        startNext();
      }
      yield value;
    }
  } finally {
    // A call nobody awaits any more must not surface as an unhandled
    // rejection, which would take the whole process down.
    for (const pending of inFlight.values()) {
      pending.catch(() => {});
    }
  }
}
