/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the seeded generator the environment simulation draws from.
 * adk-python uses CPython's `random.Random`, so there is no reference test to
 * port.
 */

import {createSeededRandom} from '@google/adk/utils/random_utils.js';
import {describe, expect, it} from 'vitest';

const DRAW_COUNT = 8;

function drawMany(seed?: number): number[] {
  const random = createSeededRandom();
  if (seed !== undefined) {
    random.seed(seed);
  }
  return Array.from({length: DRAW_COUNT}, () => random.next());
}

describe('createSeededRandom', () => {
  it('replays the same sequence for the same seed', () => {
    expect(drawMany(42)).toEqual(drawMany(42));
  });

  it('produces different sequences for different seeds', () => {
    expect(drawMany(42)).not.toEqual(drawMany(100));
  });

  it('reseeding restarts the sequence', () => {
    const random = createSeededRandom();
    random.seed(7);
    const first = random.next();
    random.next();
    random.seed(7);

    expect(random.next()).toBe(first);
  });

  it('draws inside [0, 1) when seeded', () => {
    for (const value of drawMany(2024)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('draws inside [0, 1) before it is seeded', () => {
    for (const value of drawMany()) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
