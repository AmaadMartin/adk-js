/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {canonicalJson} from '../../src/utils/json_utils.js';

describe('canonicalJson', () => {
  it('is equal for objects that differ only in key order', () => {
    expect(canonicalJson({a: 1, b: 2})).toBe(canonicalJson({b: 2, a: 1}));
  });

  it('sorts keys at every depth', () => {
    const one = {outer: {z: 1, a: {y: 2, b: 3}}};
    const other = {outer: {a: {b: 3, y: 2}, z: 1}};
    expect(canonicalJson(one)).toBe(canonicalJson(other));
    expect(canonicalJson(one)).toBe('{"outer":{"a":{"b":3,"y":2},"z":1}}');
  });

  it('differs for different values', () => {
    expect(canonicalJson({amount: 5})).not.toBe(canonicalJson({amount: 5000}));
  });

  it('treats array order as significant', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('sorts keys of objects nested inside an array', () => {
    expect(canonicalJson([{b: 1, a: 2}])).toBe('[{"a":2,"b":1}]');
  });

  it('serialises undefined as null', () => {
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('serialises primitives and null', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(7)).toBe('7');
  });

  it('throws on a cyclic value, like JSON.stringify', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(TypeError);
  });
});
