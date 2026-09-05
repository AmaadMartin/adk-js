/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {delay} from '@google/adk/utils/time_utils.js';
import {afterEach, describe, expect, it, vi} from 'vitest';

describe('delay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves only once the requested time has passed', async () => {
    vi.useFakeTimers();
    let resolved = false;

    const pending = delay(1000).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });
});
