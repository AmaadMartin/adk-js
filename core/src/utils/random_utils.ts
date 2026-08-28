/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The largest value a 32-bit unsigned integer can hold, plus one. */
const UINT32_RANGE = 4294967296;

/** The mulberry32 step constant. */
const MULBERRY32_INCREMENT = 0x6d2b79f5;

/**
 * A pseudo-random number generator that produces a repeatable sequence once it
 * is seeded.
 *
 * Without a seed it delegates to `Math.random()`. Seeding it restarts the
 * sequence, so a caller that wants a repeatable draw seeds the generator
 * immediately before it draws.
 *
 * The algorithm is mulberry32. It is fast and repeatable, but it is not a
 * cryptographic generator: do not use it for keys, tokens, or nonces.
 */
export class SeededRandom {
  private state?: number;

  /**
   * @param seed The initial seed. Omit it to draw from `Math.random()` until
   *     {@link SeededRandom.seed} is called.
   */
  constructor(seed?: number) {
    if (seed !== undefined) {
      this.seed(seed);
    }
  }

  /**
   * Restarts the sequence from the given seed.
   *
   * @param value The seed. Only its low 32 bits are used.
   */
  seed(value: number): void {
    this.state = value >>> 0;
  }

  /**
   * Draws the next value.
   *
   * @return A number uniformly distributed in `[0, 1)`.
   */
  next(): number {
    if (this.state === undefined) {
      return Math.random();
    }
    this.state = (this.state + MULBERRY32_INCREMENT) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  }
}
