/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The number of distinct values a 32-bit unsigned integer can hold. */
const UINT32_RANGE = 2 ** 32;

/**
 * A reproducible pseudo-random number generator.
 *
 * `Math.random` cannot be seeded, so a caller that has to replay the same
 * sequence needs its own generator. This one is a mulberry32: it holds a single
 * 32-bit word of state, and the same seed always yields the same sequence.
 *
 * It is not cryptographically secure. Use `node:crypto` for anything that needs
 * unpredictable values.
 */
export class SeededRandomGenerator {
  /** An arbitrary starting state, the way `Math.random` gives one. */
  private state = Math.floor(Math.random() * UINT32_RANGE);

  /**
   * Restarts the sequence from `seed`.
   *
   * @param seed The seed to restart from. It is read as a 32-bit unsigned
   *     integer, so a negative or fractional seed truncates toward zero.
   */
  seed(seed: number): void {
    this.state = seed >>> 0;
  }

  /**
   * Draws the next value.
   *
   * @returns A number in `[0, 1)`.
   */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let word = this.state;
    word = Math.imul(word ^ (word >>> 15), word | 1);
    word ^= word + Math.imul(word ^ (word >>> 7), word | 61);
    return ((word ^ (word >>> 14)) >>> 0) / UINT32_RANGE;
  }
}
