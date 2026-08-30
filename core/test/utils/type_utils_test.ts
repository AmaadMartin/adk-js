/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {isRecord, isStringArray} from '../../src/utils/type_utils.js';

describe('isRecord', () => {
  it('accepts a plain object', () => {
    expect(isRecord({a: 1})).toBe(true);
  });

  it('accepts an array, which is indexable', () => {
    expect(isRecord([1, 2])).toBe(true);
  });

  it('rejects null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isRecord(undefined)).toBe(false);
  });

  it('rejects a primitive', () => {
    expect(isRecord('ui://a')).toBe(false);
    expect(isRecord(7)).toBe(false);
  });
});

describe('isStringArray', () => {
  it('accepts an array of strings', () => {
    expect(isStringArray(['a', 'b'])).toBe(true);
  });

  it('accepts an empty array', () => {
    expect(isStringArray([])).toBe(true);
  });

  it('rejects an array with a non-string entry', () => {
    expect(isStringArray(['a', 1])).toBe(false);
  });

  it('rejects a non-array', () => {
    expect(isStringArray('a')).toBe(false);
  });
});
