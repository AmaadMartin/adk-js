/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isPlainObject} from '../../src/utils/object_utils.js';

class Sample {}

class Populated {
  a = 1;
}

class GetterOnly {
  get x(): number {
    return 1;
  }
}

describe('isPlainObject', () => {
  it('is true for object literals', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({a: 1})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
  });

  it('is false for arrays, null, primitives and class instances', () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(undefined)).toBe(false);
    expect(isPlainObject('x')).toBe(false);
    expect(isPlainObject(0)).toBe(false);
    expect(isPlainObject(new Sample())).toBe(false);
  });

  it('is false for built-in objects that serialize poorly', () => {
    expect(isPlainObject(new Date())).toBe(false);
    expect(isPlainObject(new Map())).toBe(false);
    expect(isPlainObject(new Set())).toBe(false);
    expect(isPlainObject(/re/)).toBe(false);
    expect(isPlainObject(new Error('x'))).toBe(false);
  });

  it('is false for a class instance whether or not it has own properties', () => {
    expect(isPlainObject(new Populated())).toBe(false);
    expect(isPlainObject(new GetterOnly())).toBe(false);
  });
});
