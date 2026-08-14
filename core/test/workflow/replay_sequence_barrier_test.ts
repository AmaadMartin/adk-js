/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import type {ReplayDivergenceError} from '../../src/workflow/errors.js';
import {isReplayDivergenceError} from '../../src/workflow/errors.js';
import {ReplaySequenceBarrier} from '../../src/workflow/utils/replay_sequence_barrier.js';

/** Lets every already-resolved promise settle without advancing the clock. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ReplaySequenceBarrier', () => {
  it('opens only the first key of the recorded sequence', () => {
    const barrier = new ReplaySequenceBarrier(['NodeA@1', 'NodeB@1']);

    expect(barrier.sequence).toEqual(['NodeA@1', 'NodeB@1']);
    expect(barrier.currentIndex).toBe(0);
    expect(barrier.isOpen('NodeA@1')).toBe(true);
    expect(barrier.isOpen('NodeB@1')).toBe(false);
  });

  it('holds the second key until the first one advances', async () => {
    const barrier = new ReplaySequenceBarrier(['NodeA@1', 'NodeB@1']);

    await barrier.wait('NodeA@1');

    let released = false;
    const pending = barrier.wait('NodeB@1').then(() => {
      released = true;
    });
    await flushMicrotasks();
    expect(released).toBe(false);

    barrier.checkAndAdvance('NodeA@1');
    await pending;

    expect(released).toBe(true);
    expect(barrier.currentIndex).toBe(1);
    expect(barrier.isOpen('NodeB@1')).toBe(true);
  });

  it('ignores an out-of-order advance', () => {
    const barrier = new ReplaySequenceBarrier(['NodeA@1', 'NodeB@1']);

    barrier.checkAndAdvance('NodeB@1');

    expect(barrier.currentIndex).toBe(0);
    expect(barrier.isOpen('NodeB@1')).toBe(false);
  });

  it('ignores an advance once the whole sequence has completed', () => {
    const barrier = new ReplaySequenceBarrier(['NodeA@1']);

    barrier.checkAndAdvance('NodeA@1');
    barrier.checkAndAdvance('NodeA@1');

    expect(barrier.currentIndex).toBe(1);
  });

  it('never blocks a key outside the recorded sequence', async () => {
    const barrier = new ReplaySequenceBarrier(['NodeA@1']);

    await barrier.wait('NonExistent@1');

    expect(barrier.isOpen('NonExistent@1')).toBe(true);
  });

  it('never blocks anything when the recording is empty', async () => {
    const barrier = new ReplaySequenceBarrier([]);

    await barrier.wait('NodeA@1');

    expect(barrier.currentIndex).toBe(0);
    expect(barrier.isOpen('NodeA@1')).toBe(true);
  });

  it('collapses a duplicate key onto one gate', async () => {
    const barrier = new ReplaySequenceBarrier(['NodeA@1', 'NodeA@1']);

    barrier.checkAndAdvance('NodeA@1');
    await barrier.wait('NodeA@1');

    expect(barrier.currentIndex).toBe(1);
  });

  it('fails with a replay divergence error when a gate never opens', async () => {
    const barrier = new ReplaySequenceBarrier(['NodeA@1', 'NodeB@1'], 10);

    const error = await barrier.wait('NodeB@1').catch((e: unknown) => e);

    expect(isReplayDivergenceError(error)).toBe(true);
    const divergence = error as ReplayDivergenceError;
    expect(divergence.message).toBe(
      'Replay divergence detected: Timed out waiting for sequence key ' +
        "'NodeB@1' to be unblocked.",
    );
    expect(divergence.sequenceKey).toBe('NodeB@1');
    expect(divergence.timeoutMs).toBe(10);
  });

  it('clears its deadline timer once the gate opens', async () => {
    vi.useFakeTimers();
    try {
      const barrier = new ReplaySequenceBarrier(['NodeA@1', 'NodeB@1']);

      const pending = barrier.wait('NodeB@1');
      expect(vi.getTimerCount()).toBe(1);

      barrier.checkAndAdvance('NodeA@1');
      await pending;

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts no timer for a key that is already open', async () => {
    vi.useFakeTimers();
    try {
      const barrier = new ReplaySequenceBarrier(['NodeA@1', 'NodeB@1']);

      await barrier.wait('NodeA@1');

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
