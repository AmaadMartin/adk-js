/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {AsyncQueue} from '../../src/utils/async_queue.js';

describe('AsyncQueue', () => {
  it('should yield pushed values', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();

    const results: number[] = [];
    for await (const val of queue) {
      results.push(val);
    }

    expect(results).toEqual([1, 2]);
  });

  it('should handle values pushed after iteration started', async () => {
    const queue = new AsyncQueue<number>();
    const results: number[] = [];

    const iteration = (async () => {
      for await (const val of queue) {
        results.push(val);
      }
    })();

    queue.push(1);
    queue.push(2);
    queue.close();

    await iteration;

    expect(results).toEqual([1, 2]);
  });

  it('should terminate iteration when closed empty', async () => {
    const queue = new AsyncQueue<number>();
    queue.close();

    const results: number[] = [];
    for await (const val of queue) {
      results.push(val);
    }

    expect(results).toEqual([]);
  });

  it('should propagate error to pending and subsequent next calls', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();

    const pendingNext = iterator.next();
    queue.error(new Error('Test error'));

    await expect(pendingNext).rejects.toThrow('Test error');
    await expect(iterator.next()).rejects.toThrow('Test error');
  });

  it('should ignore push after close', async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    queue.push(1);

    const results: number[] = [];
    for await (const val of queue) {
      results.push(val);
    }

    expect(results).toEqual([]);
  });

  it('should resolve pending next() call when closed', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.close();
    const res = await pending;
    expect(res.done).toBe(true);
  });

  it('should carry an undefined value on the pending next() resolved by close', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.close();

    await expect(pending).resolves.toStrictEqual({
      value: undefined,
      done: true,
    });
  });

  it('should return an undefined done result when already closed', async () => {
    const queue = new AsyncQueue<number>();
    queue.close();

    const iterator = queue[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toStrictEqual({
      value: undefined,
      done: true,
    });
  });
});
