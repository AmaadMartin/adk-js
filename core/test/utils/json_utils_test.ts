/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {rendersAsEmptyJsonObject} from '../../src/utils/json_utils.js';

/** State behind a getter, the shape `JSON.stringify` cannot see. */
class Balance {
  readonly #cents: number;

  constructor(cents: number) {
    this.#cents = cents;
  }

  get cents(): number {
    return this.#cents;
  }
}

/** A non-plain object `JSON.stringify` refuses: it holds a bigint. */
class BigintHolder {
  readonly amount = 1n;
}

/** A non-plain object `JSON.stringify` refuses: it references itself. */
class SelfReferential {
  readonly self: SelfReferential;

  constructor() {
    this.self = this;
  }
}

describe('rendersAsEmptyJsonObject', () => {
  it('reports a populated Map', () => {
    expect(rendersAsEmptyJsonObject(new Map([['a', 1]]))).toBe(true);
  });

  it('reports an empty Map', () => {
    expect(rendersAsEmptyJsonObject(new Map())).toBe(true);
  });

  it('reports a Set', () => {
    expect(rendersAsEmptyJsonObject(new Set([1, 2]))).toBe(true);
  });

  it('reports a RegExp', () => {
    expect(rendersAsEmptyJsonObject(/x/g)).toBe(true);
  });

  it('reports an Error', () => {
    expect(rendersAsEmptyJsonObject(new Error('boom'))).toBe(true);
  });

  it('reports a class instance whose state sits behind a getter', () => {
    expect(rendersAsEmptyJsonObject(new Balance(100))).toBe(true);
  });

  it('exempts an empty plain object', () => {
    expect(rendersAsEmptyJsonObject({})).toBe(false);
  });

  it('exempts a populated plain object', () => {
    expect(rendersAsEmptyJsonObject({a: 1})).toBe(false);
  });

  it('exempts an empty array', () => {
    expect(rendersAsEmptyJsonObject([])).toBe(false);
  });

  it('exempts a populated array', () => {
    expect(rendersAsEmptyJsonObject([1, 2])).toBe(false);
  });

  it('exempts an array holding a Map, because only the top level is read', () => {
    expect(rendersAsEmptyJsonObject([new Map([['a', 1]])])).toBe(false);
  });

  it('exempts a Date, which serializes to a string', () => {
    expect(rendersAsEmptyJsonObject(new Date(0))).toBe(false);
  });

  it('exempts a string', () => {
    expect(rendersAsEmptyJsonObject('str')).toBe(false);
  });

  it('exempts a number', () => {
    expect(rendersAsEmptyJsonObject(42)).toBe(false);
  });

  it('exempts a boolean', () => {
    expect(rendersAsEmptyJsonObject(true)).toBe(false);
  });

  it('exempts null', () => {
    expect(rendersAsEmptyJsonObject(null)).toBe(false);
  });

  it('exempts undefined', () => {
    expect(rendersAsEmptyJsonObject(undefined)).toBe(false);
  });

  it('stays quiet when JSON.stringify throws on a bigint', () => {
    const holder = new BigintHolder();
    expect(() => JSON.stringify(holder)).toThrow(TypeError);
    expect(rendersAsEmptyJsonObject(holder)).toBe(false);
  });

  it('stays quiet when JSON.stringify throws on a circular reference', () => {
    const holder = new SelfReferential();
    expect(() => JSON.stringify(holder)).toThrow(TypeError);
    expect(rendersAsEmptyJsonObject(holder)).toBe(false);
  });
});
