/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {Semaphore} from '../../src/utils/semaphore.js';

/** A promise plus the handles that settle it, so a test can hold a task open. */
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

/** Yields to the microtask queue so pending admissions can settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('Semaphore', () => {
  it.each([0, -1, 1.5, Number.NaN])(
    'rejects a permit count of %s',
    (permits) => {
      expect(() => new Semaphore(permits)).toThrow(RangeError);
    },
  );

  it('runs a task and returns its value', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(async () => 'done')).resolves.toBe('done');
  });

  it('admits at most the permitted number of tasks at once', async () => {
    const semaphore = new Semaphore(2);
    const gates = [deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;

    const runs = gates.map((gate) =>
      semaphore.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await gate.promise;
        running--;
      }),
    );

    await flush();
    expect(peak).toBe(2);

    gates[0].resolve();
    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(runs);
    expect(peak).toBe(2);
  });

  it('admits waiters in the order they arrived', async () => {
    const semaphore = new Semaphore(1);
    const blocker = deferred();
    const admitted: string[] = [];

    const first = semaphore.run(async () => {
      admitted.push('first');
      await blocker.promise;
    });
    const second = semaphore.run(async () => {
      admitted.push('second');
    });
    const third = semaphore.run(async () => {
      admitted.push('third');
    });

    await flush();
    expect(admitted).toEqual(['first']);

    blocker.resolve();
    await Promise.all([first, second, third]);
    expect(admitted).toEqual(['first', 'second', 'third']);
  });

  it('releases the permit when the task rejects', async () => {
    const semaphore = new Semaphore(1);

    await expect(
      semaphore.run(() => Promise.reject(new Error('task failed'))),
    ).rejects.toThrow('task failed');

    // A leaked permit would make this never settle.
    await expect(semaphore.run(async () => 'after')).resolves.toBe('after');
  });
});
