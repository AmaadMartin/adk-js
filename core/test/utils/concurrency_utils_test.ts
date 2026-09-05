/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it} from 'vitest';

import {
  mapConcurrent,
  mapWithConcurrency,
} from '../../src/utils/concurrency_utils.js';

/** Resolves after the event loop has drained the pending microtasks. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1));
}

describe('mapWithConcurrency', () => {
  it('returns the results in input order', async () => {
    const items = [30, 20, 10, 0];

    const settled = await mapWithConcurrency(items, 4, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item));
      return item * 2;
    });

    expect(settled).toEqual([
      {status: 'fulfilled', value: 60},
      {status: 'fulfilled', value: 40},
      {status: 'fulfilled', value: 20},
      {status: 'fulfilled', value: 0},
    ]);
  });

  it('passes the index of each item to the task', async () => {
    const settled = await mapWithConcurrency(
      ['a', 'b', 'c'],
      2,
      async (item, index) => `${index}:${item}`,
    );

    expect(settled.map((outcome) => outcome.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(settled).toEqual([
      {status: 'fulfilled', value: '0:a'},
      {status: 'fulfilled', value: '1:b'},
      {status: 'fulfilled', value: '2:c'},
    ]);
  });

  it('never runs more tasks at once than the limit', async () => {
    let active = 0;
    let maxActive = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await tick();
      active--;
    });

    expect(maxActive).toBe(3);
  });

  it('runs the tasks one at a time when the limit is 1', async () => {
    const order: string[] = [];

    await mapWithConcurrency([1, 2, 3], 1, async (item) => {
      order.push(`start ${item}`);
      await tick();
      order.push(`end ${item}`);
    });

    expect(order).toEqual([
      'start 1',
      'end 1',
      'start 2',
      'end 2',
      'start 3',
      'end 3',
    ]);
  });

  it('settles a failing item without cancelling the rest', async () => {
    const failure = new Error('item 2 failed');

    const settled = await mapWithConcurrency([1, 2, 3], 2, async (item) => {
      if (item === 2) {
        throw failure;
      }
      return item;
    });

    expect(settled).toEqual([
      {status: 'fulfilled', value: 1},
      {status: 'rejected', reason: failure},
      {status: 'fulfilled', value: 3},
    ]);
  });

  it('returns an empty array without starting a task', async () => {
    let started = 0;

    const settled = await mapWithConcurrency([], 4, async () => {
      started++;
    });

    expect(settled).toEqual([]);
    expect(started).toBe(0);
  });

  it.each([0, -1])('rejects a limit of %i', async (limit) => {
    await expect(
      mapWithConcurrency([1], limit, async (item) => item),
    ).rejects.toThrow(RangeError);
  });
});

/** A promise the test settles by hand. */
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

/** Lets every already-scheduled microtask run. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Collects the unhandled rejections raised while `body` runs. */
async function collectUnhandledRejections(
  body: () => Promise<void>,
): Promise<unknown[]> {
  const reasons: unknown[] = [];
  const onUnhandled = (reason: unknown) => reasons.push(reason);
  const existing = process.listeners('unhandledRejection');
  for (const listener of existing) {
    process.off('unhandledRejection', listener);
  }
  process.on('unhandledRejection', onUnhandled);
  try {
    await body();
    await flushMicrotasks();
  } finally {
    process.off('unhandledRejection', onUnhandled);
    for (const listener of existing) {
      process.on('unhandledRejection', listener);
    }
  }
  return reasons;
}

async function collect<T>(source: AsyncGenerator<T>): Promise<T[]> {
  const collected: T[] = [];
  for await (const item of source) {
    collected.push(item);
  }
  return collected;
}

describe('mapConcurrent', () => {
  afterEach(async () => {
    await flushMicrotasks();
  });

  it('yields results in completion order, not input order', async () => {
    const deferreds = [new Deferred<string>(), new Deferred<string>()];
    const results = collect(
      mapConcurrent(
        [0, 1],
        2,
        async (index: number) => deferreds[index].promise,
      ),
    );

    deferreds[1].resolve('second started, first done');
    await flushMicrotasks();
    deferreds[0].resolve('first started, second done');

    expect(await results).toEqual([
      'second started, first done',
      'first started, second done',
    ]);
  });

  it('never runs more tasks than the limit allows', async () => {
    let inFlight = 0;
    let peak = 0;
    const deferreds = [0, 1, 2, 3].map(() => new Deferred<number>());

    const results = collect(
      mapConcurrent([0, 1, 2, 3], 2, async (index: number) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        try {
          return await deferreds[index].promise;
        } finally {
          inFlight--;
        }
      }),
    );

    for (const [index, deferred] of deferreds.entries()) {
      await flushMicrotasks();
      deferred.resolve(index);
    }

    expect(await results).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it('treats a limit below one as one', async () => {
    let inFlight = 0;
    let peak = 0;

    const results = await collect(
      mapConcurrent([1, 2, 3], 0, async (value: number) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await flushMicrotasks();
        inFlight--;
        return value * 2;
      }),
    );

    expect(results).toEqual([2, 4, 6]);
    expect(peak).toBe(1);
  });

  it('starts nothing for an empty input', async () => {
    let started = 0;

    const results = await collect(
      mapConcurrent([], 4, async () => {
        started++;
        return 'never';
      }),
    );

    expect(results).toEqual([]);
    expect(started).toBe(0);
  });

  it('rejects with the first failure and leaves no rejection unhandled', async () => {
    const first = new Deferred<string>();
    const second = new Deferred<string>();

    const reasons = await collectUnhandledRejections(async () => {
      const results = collect(
        mapConcurrent([first, second], 2, async (deferred) => deferred.promise),
      );
      first.reject(new Error('first failed'));
      second.reject(new Error('second failed'));

      await expect(results).rejects.toThrow('first failed');
    });

    expect(reasons).toEqual([]);
  });

  it('swallows a running task when starting the next one throws', async () => {
    const running = new Deferred<number>();

    const reasons = await collectUnhandledRejections(async () => {
      const results = collect(
        mapConcurrent([0, 1], 2, (index: number) => {
          if (index === 1) {
            throw new Error('could not start');
          }
          return running.promise;
        }),
      );

      await expect(results).rejects.toThrow('could not start');
      running.reject(new Error('nobody is listening'));
    });

    expect(reasons).toEqual([]);
  });

  it('stops starting tasks and swallows pending failures when the consumer breaks', async () => {
    const started: number[] = [];
    const failing = new Deferred<number>();

    const reasons = await collectUnhandledRejections(async () => {
      for await (const value of mapConcurrent([0, 1, 2], 2, async (index) => {
        started.push(index);
        if (index === 1) {
          return failing.promise;
        }
        return index;
      })) {
        expect(value).toBe(0);
        break;
      }
      failing.reject(new Error('nobody is listening'));
    });

    expect(started).toEqual([0, 1]);
    expect(reasons).toEqual([]);
  });
});
