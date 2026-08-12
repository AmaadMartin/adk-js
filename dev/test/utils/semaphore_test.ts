/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {Semaphore} from '../../src/utils/semaphore.js';

/** A promise plus the handles that settle it from the test body. */
function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

describe('Semaphore', () => {
  it('rejects a permit count that is not a positive integer', () => {
    expect(() => new Semaphore(0)).toThrow(
      'Semaphore permits must be a positive integer, got: 0',
    );
    expect(() => new Semaphore(-1)).toThrow('positive integer');
    expect(() => new Semaphore(1.5)).toThrow('positive integer');
    expect(() => new Semaphore(Number.NaN)).toThrow('positive integer');
  });

  it('keeps concurrency at or below the permit count under a burst', async () => {
    const semaphore = new Semaphore(2);
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({length: 10}, () =>
        semaphore.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 1));
          running--;
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(running).toBe(0);
  });

  it('returns the value of the task', async () => {
    const semaphore = new Semaphore(1);

    await expect(semaphore.run(async () => 'done')).resolves.toBe('done');
  });

  it('releases the permit when the task rejects', async () => {
    const semaphore = new Semaphore(1);

    await expect(
      semaphore.run(() => Promise.reject(new Error('task failed'))),
    ).rejects.toThrow('task failed');

    await expect(semaphore.run(async () => 'still usable')).resolves.toBe(
      'still usable',
    );
  });

  it('admits waiters in FIFO order', async () => {
    const semaphore = new Semaphore(1);
    const blocker = deferred();
    const order: string[] = [];

    const held = semaphore.run(async () => {
      await blocker.promise;
      order.push('first');
    });
    const second = semaphore.run(async () => {
      order.push('second');
    });
    const third = semaphore.run(async () => {
      order.push('third');
    });

    expect(order).toEqual([]);
    blocker.resolve();
    await Promise.all([held, second, third]);

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('hands a released permit to the next waiter without widening the bound', async () => {
    const semaphore = new Semaphore(1);
    const blocker = deferred();
    let running = 0;
    let peak = 0;

    const track = async (wait?: Promise<void>) =>
      semaphore.run(async () => {
        running++;
        peak = Math.max(peak, running);
        if (wait) {
          await wait;
        }
        running--;
      });

    const first = track(blocker.promise);
    const queued = [track(), track()];
    blocker.resolve();
    await Promise.all([first, ...queued]);

    expect(peak).toBe(1);
  });
});
