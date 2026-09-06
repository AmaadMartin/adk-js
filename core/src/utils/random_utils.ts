/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Creates a deterministic pseudo-random generator yielding values in `[0, 1)`.
 *
 * `Math.random()` cannot be seeded, so callers that need reproducible draws
 * (the same seed always producing the same sequence) use this instead. The
 * implementation is mulberry32, a 32-bit generator.
 *
 * This generator is NOT cryptographically secure. Never use it for tokens,
 * identifiers, or anything else security-relevant; use `randomUUID` from
 * `env_aware_utils.ts` for those.
 *
 * @param seed The seed value. Coerced to a 32-bit integer.
 * @returns A function returning the next value of the sequence, in `[0, 1)`.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
