/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError, mapConcurrent} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A promise whose settlement the test controls. */
class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (reason: Error) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/** Counts how many calls of `fn` overlap. */
function trackConcurrency<T, R>(fn: (item: T) => Promise<R>) {
  const state = {live: 0, highWaterMark: 0};
  const tracked = async (item: T): Promise<R> => {
    state.live++;
    state.highWaterMark = Math.max(state.highWaterMark, state.live);
    try {
      return await fn(item);
    } finally {
      state.live--;
    }
  };
  return {state, tracked};
}

async function collect<R>(results: AsyncGenerator<R>): Promise<R[]> {
  const collected: R[] = [];
  for await (const result of results) {
    collected.push(result);
  }
  return collected;
}

describe('mapConcurrent', () => {
  it('yields nothing for an empty input', async () => {
    const results = await collect(
      mapConcurrent([], 2, async (item: number) => item),
    );

    expect(results).toEqual([]);
  });

  it('runs one call at a time at a limit of 1', async () => {
    const order: string[] = [];
    const {state, tracked} = trackConcurrency(async (item: number) => {
      order.push(`start ${item}`);
      await Promise.resolve();
      order.push(`end ${item}`);
      return item;
    });

    const results = await collect(mapConcurrent([1, 2, 3], 1, tracked));

    expect(results).toEqual([1, 2, 3]);
    expect(state.highWaterMark).toBe(1);
    expect(order).toEqual([
      'start 1',
      'end 1',
      'start 2',
      'end 2',
      'start 3',
      'end 3',
    ]);
  });

  it('never exceeds the limit with more items than the limit', async () => {
    const gates = [0, 1, 2, 3].map(() => new Deferred<number>());
    const {state, tracked} = trackConcurrency(
      (index: number) => gates[index].promise,
    );

    const results = mapConcurrent([0, 1, 2, 3], 2, tracked);
    const collected: number[] = [];
    const drained = (async () => {
      for await (const result of results) {
        collected.push(result);
      }
    })();

    await Promise.resolve();
    expect(state.live).toBe(2);

    for (const [index, gate] of gates.entries()) {
      gate.resolve(index);
      await Promise.resolve();
    }
    await drained;

    expect(collected.sort()).toEqual([0, 1, 2, 3]);
    expect(state.highWaterMark).toBe(2);
  });

  it('starts every item at once when the limit exceeds the item count', async () => {
    const {state, tracked} = trackConcurrency(async (item: number) => item);

    await collect(mapConcurrent([1, 2], 10, tracked));

    expect(state.highWaterMark).toBe(2);
  });

  it('yields in completion order, not input order', async () => {
    const gates = [new Deferred<string>(), new Deferred<string>()];

    const results = mapConcurrent(
      [0, 1],
      2,
      (index: number) => gates[index].promise,
    );
    const collected: string[] = [];
    const drained = (async () => {
      for await (const result of results) {
        collected.push(result);
      }
    })();

    gates[1].resolve('second item');
    await Promise.resolve();
    gates[0].resolve('first item');
    await drained;

    expect(collected).toEqual(['second item', 'first item']);
  });

  it('rejects with the error a call raised', async () => {
    const failure = new Error('the call failed');

    await expect(
      collect(
        mapConcurrent([1], 1, () => {
          return Promise.reject(failure);
        }),
      ),
    ).rejects.toThrow(failure);
  });

  it('leaves no unhandled rejection when the consumer stops early', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const abandoned = new Deferred<number>();

    try {
      // A limit of 1 starts the second call as the first one settles, so the
      // call the consumer abandons is one no `Promise.race` is watching.
      for await (const result of mapConcurrent([0, 1, 2], 1, (index: number) =>
        index === 0 ? Promise.resolve(0) : abandoned.promise,
      )) {
        expect(result).toBe(0);
        break;
      }

      abandoned.reject(new Error('the abandoned call failed'));
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'rejects a limit of %s',
    async (limit: number) => {
      await expect(
        collect(mapConcurrent([1], limit, async (item: number) => item)),
      ).rejects.toThrow(InputValidationError);
    },
  );
});
