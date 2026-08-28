/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {seededRandom} from '../../src/utils/random_utils.js';

describe('seededRandom', () => {
  it('gives the same value for the same seed', () => {
    expect(seededRandom(42)).toBe(seededRandom(42));
  });

  it('gives a different value for a different seed', () => {
    expect(seededRandom(42)).not.toBe(seededRandom(43));
  });

  it('keeps every value in the unit interval', () => {
    for (let seed = 0; seed < 500; seed++) {
      const value = seededRandom(seed);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('spreads values across the interval', () => {
    const values = Array.from({length: 200}, (_, seed) => seededRandom(seed));

    expect(Math.min(...values)).toBeLessThan(0.1);
    expect(Math.max(...values)).toBeGreaterThan(0.9);
  });
});
