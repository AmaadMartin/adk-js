/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {createSeededRandom} from '../../src/utils/random_utils.js';

function draw(seed: number, count: number): number[] {
  const next = createSeededRandom(seed);
  return Array.from({length: count}, () => next());
}

describe('createSeededRandom', () => {
  it('produces an identical sequence for an identical seed', () => {
    expect(draw(7, 10)).toEqual(draw(7, 10));
  });

  it('produces different sequences for different seeds', () => {
    expect(draw(7, 10)).not.toEqual(draw(8, 10));
  });

  it('advances the stream on every call', () => {
    const next = createSeededRandom(7);
    expect(next()).not.toEqual(next());
  });

  it('keeps every value of a long run within [0, 1)', () => {
    for (const value of draw(1234, 10000)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('keeps values within [0, 1) for negative and zero seeds', () => {
    for (const seed of [0, -1, -2147483648, 2147483647]) {
      for (const value of draw(seed, 100)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(1);
      }
    }
  });
});
