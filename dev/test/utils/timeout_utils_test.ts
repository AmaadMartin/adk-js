/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {runWithTimeout} from '../../src/utils/timeout_utils.js';

describe('runWithTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports no timeout when the body finishes first', async () => {
    let seen: AbortSignal | undefined;

    const timedOut = await runWithTimeout(5000, async (signal) => {
      seen = signal;
    });

    expect(timedOut).toBe(false);
    expect(seen?.aborted).toBe(false);
  });

  it('runs without a deadline when none is given', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const timedOut = await runWithTimeout(undefined, async () => {});

    expect(timedOut).toBe(false);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('aborts the body and reports the timeout when the deadline passes', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;

    const pending = runWithTimeout(1000, async (signal) => {
      seen = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve());
      });
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(await pending).toBe(true);
    expect(seen?.aborted).toBe(true);
  });

  it('swallows the failure a body reports after it was aborted', async () => {
    vi.useFakeTimers();

    const pending = runWithTimeout(1000, async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve());
      });
      throw new Error('aborted mid-stream');
    });
    await vi.advanceTimersByTimeAsync(1000);

    expect(await pending).toBe(true);
  });

  it('rethrows a failure that is not the deadline', async () => {
    await expect(
      runWithTimeout(5000, async () => {
        throw new Error('agent exploded');
      }),
    ).rejects.toThrow('agent exploded');
  });

  it('clears the deadline once the body finishes', async () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    await runWithTimeout(1000, async () => {});
    await vi.advanceTimersByTimeAsync(2000);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
