/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {SeededRandomGenerator} from '../../src/utils/random_utils.js';

function seeded(seed: number): SeededRandomGenerator {
  const generator = new SeededRandomGenerator();
  generator.seed(seed);
  return generator;
}

function draw(generator: SeededRandomGenerator, count: number): number[] {
  return Array.from({length: count}, () => generator.next());
}

describe('SeededRandomGenerator', () => {
  it('replays the same sequence for the same seed', () => {
    expect(draw(seeded(42), 5)).toEqual(draw(seeded(42), 5));
  });

  it('produces a different sequence for a different seed', () => {
    expect(draw(seeded(42), 5)).not.toEqual(draw(seeded(100), 5));
  });

  it('restarts the sequence when reseeded', () => {
    const generator = seeded(1);
    const first = draw(generator, 3);

    generator.seed(1);

    expect(draw(generator, 3)).toEqual(first);
  });

  it('keeps every draw inside [0, 1)', () => {
    const generator = seeded(2024);
    for (const value of draw(generator, 1000)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('advances on each draw', () => {
    const generator = seeded(3);
    const values = draw(generator, 100);

    expect(new Set(values).size).toBe(values.length);
  });

  it('starts from an arbitrary state before it is seeded', () => {
    const first = draw(new SeededRandomGenerator(), 5);
    const second = draw(new SeededRandomGenerator(), 5);

    expect(first).not.toEqual(second);
  });

  it('treats a negative seed as its unsigned 32-bit value', () => {
    expect(draw(seeded(-1), 3)).toEqual(draw(seeded(0xffffffff), 3));
  });

  it('truncates a fractional seed toward zero', () => {
    expect(draw(seeded(-1.5), 3)).toEqual(draw(seeded(-1), 3));
  });
});
