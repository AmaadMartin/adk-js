/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {mapWithConcurrency} from '../../src/utils/concurrency_utils.js';

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
