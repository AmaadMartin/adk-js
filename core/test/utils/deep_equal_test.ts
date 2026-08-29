/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {deepEqual} from '../../src/utils/deep_equal.js';

describe('deepEqual', () => {
  it('compares primitives by value', () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual('a', 'a')).toBe(true);
    expect(deepEqual(true, true)).toBe(true);
    expect(deepEqual(1, 2)).toBe(false);
    expect(deepEqual('a', 'b')).toBe(false);
  });

  it('treats NaN as equal to itself, following Object.is', () => {
    expect(deepEqual(Number.NaN, Number.NaN)).toBe(true);
  });

  it('distinguishes 0 from -0, following Object.is', () => {
    expect(deepEqual(0, -0)).toBe(false);
  });

  it('does not treat null as an object', () => {
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual({}, null)).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
  });

  it('does not equate a primitive with an object', () => {
    expect(deepEqual(1, {})).toBe(false);
    expect(deepEqual({}, 'a')).toBe(false);
    expect(deepEqual(undefined, {})).toBe(false);
  });

  it('does not equate an array with a plain object', () => {
    expect(deepEqual([1], {0: 1})).toBe(false);
    expect(deepEqual({0: 1}, [1])).toBe(false);
  });

  it('compares arrays element-wise', () => {
    expect(deepEqual([1, 'a', true], [1, 'a', true])).toBe(true);
    expect(deepEqual([], [])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });

  it('rejects arrays of differing length', () => {
    expect(deepEqual([1, 2], [1])).toBe(false);
    expect(deepEqual([1], [1, 2])).toBe(false);
  });

  it('ignores object key order', () => {
    expect(deepEqual({a: 1, b: 2}, {b: 2, a: 1})).toBe(true);
  });

  it('rejects an object carrying an extra key', () => {
    expect(deepEqual({a: 1}, {a: 1, b: 2})).toBe(false);
    expect(deepEqual({a: 1, b: 2}, {a: 1})).toBe(false);
  });

  it('rejects equal-sized objects with different key names', () => {
    expect(deepEqual({a: 1}, {b: 1})).toBe(false);
  });

  it('rejects objects that differ only in a value', () => {
    expect(deepEqual({a: 1}, {a: 2})).toBe(false);
  });

  it('compares nested structures recursively', () => {
    expect(
      deepEqual(
        {outer: {inner: [1, {deep: 'x'}]}},
        {outer: {inner: [1, {deep: 'x'}]}},
      ),
    ).toBe(true);
    expect(
      deepEqual(
        {outer: {inner: [1, {deep: 'x'}]}},
        {outer: {inner: [1, {deep: 'y'}]}},
      ),
    ).toBe(false);
  });
});
