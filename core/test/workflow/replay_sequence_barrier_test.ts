/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python`
 * `tests/unittests/workflow/utils/test_replay_sequence_barrier.py`. All five
 * reference tests are here, under their original names.
 *
 * The reference asserts on the barrier's internal `events` dict
 * (`barrier.events['NodeA@1'].is_set()`). The TypeScript barrier keeps its
 * gates private and answers the same question through `isOpen(key)`.
 */

import {describe, expect, it, vi} from 'vitest';
import {ReplaySequenceBarrier} from '../../src/workflow/utils/replay_sequence_barrier.js';

describe('ReplaySequenceBarrier', () => {
  it('test_barrier_initialization', () => {
    const sequence = ['NodeA@1', 'NodeB@1'];

    const barrier = new ReplaySequenceBarrier(sequence);

    expect(barrier.sequence).toEqual(sequence);
    expect(barrier.currentIndex).toBe(0);
    expect(barrier.isOpen('NodeA@1')).toBe(true);
    expect(barrier.isOpen('NodeB@1')).toBe(false);
  });

  it('test_barrier_wait_blocks_and_unblocks', async () => {
    const barrier = new ReplaySequenceBarrier(['NodeA@1', 'NodeB@1']);

    await barrier.wait('NodeA@1');

    let bCompleted = false;
    const waitingForB = barrier.wait('NodeB@1').then(() => {
      bCompleted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bCompleted).toBe(false);

    barrier.checkAndAdvance('NodeA@1');

    await waitingForB;
    expect(bCompleted).toBe(true);
    expect(barrier.currentIndex).toBe(1);
    expect(barrier.isOpen('NodeB@1')).toBe(true);
  });

  it('test_barrier_advance_out_of_order_ignored', () => {
    const barrier = new ReplaySequenceBarrier(['NodeA@1', 'NodeB@1']);

    barrier.checkAndAdvance('NodeB@1');

    expect(barrier.currentIndex).toBe(0);
    expect(barrier.isOpen('NodeB@1')).toBe(false);
  });

  it('test_barrier_wait_non_existent_key', async () => {
    const barrier = new ReplaySequenceBarrier(['NodeA@1']);

    await expect(barrier.wait('NonExistent@1')).resolves.toBeUndefined();
  });

  it('test_barrier_wait_timeout_on_divergence', async () => {
    const barrier = new ReplaySequenceBarrier(['NodeA@1', 'NodeB@1'], 10);

    await expect(barrier.wait('NodeB@1')).rejects.toThrow(
      /Replay divergence detected/,
    );
  });
});

describe('ReplaySequenceBarrier — adk-js specifics', () => {
  it('advances past the last key without opening anything further', () => {
    const barrier = new ReplaySequenceBarrier(['NodeA@1']);

    barrier.checkAndAdvance('NodeA@1');
    barrier.checkAndAdvance('NodeA@1');

    expect(barrier.currentIndex).toBe(1);
  });

  it('never blocks when no sequence was recovered', async () => {
    const barrier = new ReplaySequenceBarrier([], 10);

    await expect(barrier.wait('NodeA@1')).resolves.toBeUndefined();
    expect(barrier.currentIndex).toBe(0);
    expect(barrier.isOpen('NodeA@1')).toBe(false);
  });

  it('clears its timeout once a key is released', async () => {
    vi.useFakeTimers();
    try {
      const barrier = new ReplaySequenceBarrier(['NodeA@1', 'NodeB@1'], 20);
      const waitingForB = barrier.wait('NodeB@1');
      expect(vi.getTimerCount()).toBe(1);

      barrier.checkAndAdvance('NodeA@1');
      await waitingForB;

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases every waiter when the run is torn down', async () => {
    const barrier = new ReplaySequenceBarrier(['NodeA@1', 'NodeB@1'], 10);
    const waitingForB = barrier.wait('NodeB@1');

    barrier.dispose();

    await expect(waitingForB).resolves.toBeUndefined();
  });
});
