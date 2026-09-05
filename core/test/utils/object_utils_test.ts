/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
// Not part of the public entry point: an internal helper stays internal.
import {isPlainObject, isRecord} from '../../src/utils/object_utils.js';

describe('isRecord', () => {
  it('accepts a plain object', () => {
    expect(isRecord({hint: 'h'})).toBe(true);
    expect(isRecord({a: 1})).toBe(true);
    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it('rejects an array, so a field read cannot hit an index', () => {
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord([])).toBe(false);
  });

  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a string', 'hint'],
    ['a number', 1],
    ['undefined', undefined],
    ['a boolean', true],
  ])('refuses %s', (_, value) => {
    expect(isRecord(value)).toBe(false);
  });

  it('is the same guard as isPlainObject', () => {
    expect(isRecord).toBe(isPlainObject);
  });
});
