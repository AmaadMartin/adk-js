/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {deepMerge} from '../../src/utils/merge_utils.js';

describe('deepMerge', () => {
  it('unions disjoint top-level keys', () => {
    expect(deepMerge({a: 1}, {b: 2})).toEqual({a: 1, b: 2});
  });

  it('recurses into plain objects under the same key', () => {
    expect(deepMerge({a: {x: 1}}, {a: {y: 2}})).toEqual({a: {x: 1, y: 2}});
  });

  it('recurses through three levels of nesting', () => {
    expect(deepMerge({a: {b: {c: 1}}}, {a: {b: {d: 2}}})).toEqual({
      a: {b: {c: 1, d: 2}},
    });
  });

  it('replaces a nested object with a scalar from the override', () => {
    expect(deepMerge({a: {x: 1}}, {a: 5})).toEqual({a: 5});
  });

  it('replaces a scalar with a nested object from the override', () => {
    expect(deepMerge({a: 5}, {a: {x: 1}})).toEqual({a: {x: 1}});
  });

  it('replaces a nested object with null from the override', () => {
    expect(deepMerge({a: {x: 1}}, {a: null})).toEqual({a: null});
  });

  it('replaces arrays by reference instead of concatenating them', () => {
    const override = [3];
    const result = deepMerge({v: [1, 2]}, {v: override});
    expect(result['v']).toEqual([3]);
    expect(result['v']).toBe(override);
  });

  it('treats a class instance as a leaf and keeps its prototype', () => {
    const date = new Date('2026-01-02T03:04:05.000Z');
    const result = deepMerge({a: {x: 1}}, {a: date});
    expect(result['a']).toBe(date);
    expect(result['a']).toBeInstanceOf(Date);
  });

  it('does not mutate either input and returns a new object', () => {
    const base = {a: {x: 1}, keep: 'me'};
    const override = {a: {y: 2}};
    const result = deepMerge(base, override);
    expect(base).toEqual({a: {x: 1}, keep: 'me'});
    expect(override).toEqual({a: {y: 2}});
    expect(result).not.toBe(base);
    expect(result['a']).not.toBe(base.a);
    expect(result['a']).not.toBe(override.a);
  });

  it('returns a new object equal to base when the override is empty', () => {
    const base = {a: 1};
    const result = deepMerge(base, {});
    expect(result).toEqual({a: 1});
    expect(result).not.toBe(base);
  });

  it('preserves the key order of base and appends new override keys', () => {
    const result = deepMerge({b: 1, a: 2}, {c: 3, a: 4});
    expect(Object.keys(result)).toEqual(['b', 'a', 'c']);
  });

  it('skips the __proto__ key so merged data cannot pollute a prototype', () => {
    const polluted = JSON.parse('{"__proto__":{"polluted":true}}');
    const result = deepMerge({}, polluted);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
