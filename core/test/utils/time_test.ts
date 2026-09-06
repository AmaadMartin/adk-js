/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getTime, resetTimeProvider, setTimeProvider} from '@google/adk';
import {afterEach, describe, expect, it} from 'vitest';

/** Tolerance (ms) between `getTime()` and `Date.now()` on the default path. */
const CLOCK_TOLERANCE_MS = 1000;

describe('time', () => {
  afterEach(() => {
    resetTimeProvider();
  });

  it('returns the current time from the default provider', () => {
    const now = Date.now();
    const time = getTime();

    expect(typeof time).toBe('number');
    expect(Math.abs(time - now)).toBeLessThan(CLOCK_TOLERANCE_MS);
  });

  it('returns the value of a custom provider verbatim', () => {
    setTimeProvider(() => 123456789);

    expect(getTime()).toBe(123456789);
  });

  it('restores the default provider on reset', () => {
    setTimeProvider(() => 123456789);
    resetTimeProvider();

    const time = getTime();
    expect(time).not.toBe(123456789);
    expect(Math.abs(time - Date.now())).toBeLessThan(CLOCK_TOLERANCE_MS);
  });

  it('reset is safe when no provider was installed', () => {
    resetTimeProvider();

    expect(Math.abs(getTime() - Date.now())).toBeLessThan(CLOCK_TOLERANCE_MS);
  });

  it('calls the provider on every read', () => {
    let calls = 0;
    setTimeProvider(() => ++calls);

    expect([getTime(), getTime(), getTime()]).toEqual([1, 2, 3]);
  });

  it('propagates an error thrown by the provider', () => {
    setTimeProvider(() => {
      throw new Error('no clock');
    });

    expect(() => getTime()).toThrow('no clock');
  });
});
