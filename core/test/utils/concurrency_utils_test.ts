/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

// Package-internal: this helper is not on the public barrel, so it is imported
// by module path.
import {mapWithConcurrency} from '../../src/utils/concurrency_utils.js';

/** A promise plus the resolve/reject handles the test drives it with. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

async function collect<T>(stream: AsyncGenerator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const result of stream) {
    results.push(result);
  }
  return results;
}

describe('mapWithConcurrency', () => {
  it('maps every item', async () => {
    const results = await collect(
      mapWithConcurrency([1, 2, 3], 2, async (item) => item * 2),
    );

    expect(results.sort((a, b) => a - b)).toEqual([2, 4, 6]);
  });

  it('yields an empty stream for no items', async () => {
    const results = await collect(
      mapWithConcurrency<number, number>([], 4, async (item) => item),
    );

    expect(results).toEqual([]);
  });

  it('never runs more than `limit` at once', async () => {
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
    let running = 0;
    let peak = 0;

    const stream = mapWithConcurrency([0, 1, 2], 2, async (index) => {
      running++;
      peak = Math.max(peak, running);
      const value = await gates[index].promise;
      running--;
      return value;
    });

    const collected = collect(stream);
    gates.forEach((gate, index) => gate.resolve(index));
    await collected;

    expect(peak).toBe(2);
  });

  it('yields in completion order, not input order', async () => {
    const gates = [deferred<string>(), deferred<string>()];
    const stream = mapWithConcurrency(
      [0, 1],
      2,
      async (index) => gates[index].promise,
    );

    // Only the second item can settle, so it must come out first.
    gates[1].resolve('from index 1');
    expect((await stream.next()).value).toBe('from index 1');

    gates[0].resolve('from index 0');
    expect((await stream.next()).value).toBe('from index 0');
  });

  it('treats a non-numeric limit as one at a time', async () => {
    let running = 0;
    let peak = 0;

    const results = await collect(
      mapWithConcurrency([1, 2, 3], Number.NaN, async (item) => {
        running++;
        peak = Math.max(peak, running);
        await Promise.resolve();
        running--;
        return item;
      }),
    );

    expect(peak).toBe(1);
    expect(results).toEqual([1, 2, 3]);
  });

  it('treats a zero limit as one at a time', async () => {
    const results = await collect(
      mapWithConcurrency([1, 2], 0, async (item) => item),
    );

    expect(results).toEqual([1, 2]);
  });

  it('propagates the first rejection to the consumer', async () => {
    const stream = mapWithConcurrency([1, 2], 2, async (item) => {
      if (item === 1) {
        throw new Error('boom');
      }
      return item;
    });

    await expect(collect(stream)).rejects.toThrow('boom');
  });

  it('does not leave a rejected sibling unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', onUnhandled);

    try {
      const stream = mapWithConcurrency([1, 2], 2, async (item) => {
        throw new Error(`boom ${item}`);
      });
      await expect(collect(stream)).rejects.toThrow(/boom/);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });
});
