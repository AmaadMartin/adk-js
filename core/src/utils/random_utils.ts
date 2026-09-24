/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** A generator of numbers in `[0, 1)` that a caller can make reproducible. */
export interface SeededRandom {
  /** Restarts the sequence from `value`. The same value replays it. */
  seed(value: number): void;

  /** Draws the next number in `[0, 1)`. */
  next(): number;
}

/**
 * Builds a mulberry32 generator from `state`.
 *
 * mulberry32 is a 32-bit generator with a 2^32 period. It is reproducible and
 * cheap, which is what a seeded draw needs; it is not suitable for anything
 * that requires unpredictability.
 */
function mulberry32(state: number): () => number {
  let current = state | 0;
  return () => {
    current = (current + 0x6d2b79f5) | 0;
    let t = current;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Creates a generator that draws from `Math.random` until it is seeded.
 *
 * Once {@link SeededRandom.seed} is called the sequence is reproducible, so
 * the same seed always produces the same draws.
 */
export function createSeededRandom(): SeededRandom {
  let draw: (() => number) | undefined;
  return {
    seed(value: number): void {
      draw = mulberry32(value);
    },
    next(): number {
      return draw ? draw() : Math.random();
    },
  };
}
