/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {SeededRandom} from '../../src/utils/random_utils.js';

function draw(random: SeededRandom, count: number): number[] {
  return Array.from({length: count}, () => random.next());
}

describe('SeededRandom', () => {
  it('repeats the same sequence for the same seed', () => {
    expect(draw(new SeededRandom(42), 5)).toEqual(
      draw(new SeededRandom(42), 5),
    );
  });

  it('produces a different sequence for a different seed', () => {
    expect(draw(new SeededRandom(42), 5)).not.toEqual(
      draw(new SeededRandom(43), 5),
    );
  });

  it('restarts the sequence when it is re-seeded', () => {
    const random = new SeededRandom(7);
    const first = draw(random, 3);

    random.seed(7);

    expect(draw(random, 3)).toEqual(first);
  });

  it('keeps every seeded draw in the unit interval', () => {
    for (const value of draw(new SeededRandom(1), 200)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('keeps every unseeded draw in the unit interval', () => {
    for (const value of draw(new SeededRandom(), 200)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('draws unseeded values that vary', () => {
    expect(new Set(draw(new SeededRandom(), 20)).size).toBeGreaterThan(1);
  });
});
