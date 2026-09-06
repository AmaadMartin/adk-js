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
 * Draws the mulberry32 value for a seed.
 *
 * The same seed always gives the same value, which is what makes a seeded
 * decision repeatable. It is not a cryptographic generator: do not use it for
 * keys, tokens, or nonces.
 *
 * @param seed The seed. Only its low 32 bits are used.
 * @return A number in `[0, 1)`.
 */
export function seededRandom(seed: number): number {
  let t = (seed + MULBERRY32_INCREMENT) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
}
