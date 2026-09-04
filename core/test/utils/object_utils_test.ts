/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isPlainObject, stripNullish} from '../../src/utils/object_utils.js';
import {FnNode} from '../workflow/test_helpers.js';

describe('isPlainObject', () => {
  it('is true for object literals', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({a: 1})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it('is false for arrays, null, primitives and class instances', () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(new FnNode('n', (_c, i) => i))).toBe(false);
  });

  it('is false for undefined', () => {
    expect(isPlainObject(undefined)).toBe(false);
  });
});

describe('stripNullish', () => {
  it('drops null and undefined fields', () => {
    expect(stripNullish({a: 1, b: null, c: undefined})).toEqual({a: 1});
  });

  it('recurses into a nested object field', () => {
    expect(stripNullish({outer: {a: 1, b: null}})).toEqual({outer: {a: 1}});
  });

  it('recurses into the elements of an array', () => {
    expect(stripNullish([{a: 1, b: null}])).toEqual([{a: 1}]);
  });

  it('keeps the null entries of an array', () => {
    expect(stripNullish(['a', null, 'b'])).toEqual(['a', null, 'b']);
  });

  it('returns a primitive unchanged', () => {
    expect(stripNullish('x')).toBe('x');
    expect(stripNullish(null)).toBeNull();
    expect(stripNullish(undefined)).toBeUndefined();
  });

  it('returns a class instance unchanged rather than rebuilding it', () => {
    const url = new URL('https://example.com/a');
    expect(stripNullish({site: url})).toEqual({site: url});
    expect(stripNullish(url)).toBe(url);
  });

  it('does not mutate its argument', () => {
    const value = {a: 1, b: null, nested: {c: null}};
    stripNullish(value);
    expect(value).toEqual({a: 1, b: null, nested: {c: null}});
  });
});
