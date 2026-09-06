/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';

import {sleep} from '../../src/utils/time_utils.js';

describe('sleep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves once the delay has passed', async () => {
    vi.useFakeTimers();
    let slept = false;
    void sleep(500).then(() => {
      slept = true;
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(slept).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(slept).toBe(true);
  });

  it('resolves only once the requested time has passed', async () => {
    vi.useFakeTimers();
    let resolved = false;

    const pending = sleep(1000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });

  it('resolves on a real timer too', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });
});
