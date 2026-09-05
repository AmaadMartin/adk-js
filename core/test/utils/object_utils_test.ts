/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isPlainObject} from '../../src/utils/object_utils.js';
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

  it('is false for a Map, a Set and a Date', () => {
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(new Set())).toBe(false);
    expect(isPlainObject(new Date())).toBe(false);
  });
});
