/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isJsonSafe, toJsonSafe} from '../../src/utils/json_utils.js';

describe('isJsonSafe', () => {
  it('accepts values JSON represents faithfully', () => {
    expect(isJsonSafe({a: 1, b: 'two', c: true, d: null})).toBe(true);
    expect(isJsonSafe({nested: [1, [2, {three: 3}]]})).toBe(true);
    expect(isJsonSafe({at: new Date(0)})).toBe(true);
  });

  it('accepts an undefined property, which JSON omits by design', () => {
    expect(isJsonSafe({a: undefined})).toBe(true);
  });

  it('rejects a bigint, which JSON.stringify throws on', () => {
    expect(isJsonSafe({a: 1n})).toBe(false);
  });

  it('rejects a function and a symbol, which JSON.stringify drops', () => {
    expect(isJsonSafe({a: () => 1})).toBe(false);
    expect(isJsonSafe({a: Symbol('s')})).toBe(false);
  });

  it('rejects a Map and a Set, which JSON.stringify writes as {}', () => {
    expect(isJsonSafe({a: new Map([['k', 'v']])})).toBe(false);
    expect(isJsonSafe({a: new Set([1])})).toBe(false);
  });

  it('rejects a cycle, which JSON.stringify throws on', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(isJsonSafe(cyclic)).toBe(false);
  });

  it('rejects an unsafe value nested in an array', () => {
    expect(isJsonSafe({list: [1, 2n]})).toBe(false);
  });

  it('accepts the same object appearing twice without a cycle', () => {
    const shared = {a: 1};

    expect(isJsonSafe({first: shared, second: shared})).toBe(true);
  });
});

describe('toJsonSafe', () => {
  it('leaves primitives untouched', () => {
    expect(toJsonSafe({a: 1, b: 'two', c: false, d: null})).toEqual({
      a: 1,
      b: 'two',
      c: false,
      d: null,
    });
  });

  it('replaces a bigint with its string form', () => {
    expect(toJsonSafe({a: 10n})).toEqual({a: '10'});
  });

  it('replaces a function with its string form rather than dropping it', () => {
    const coerced = toJsonSafe({callback: function named() {}});

    expect(typeof coerced['callback']).toBe('string');
    expect(coerced['callback']).toContain('named');
  });

  it('replaces a symbol with its string form', () => {
    expect(toJsonSafe({a: Symbol('tag')})).toEqual({a: 'Symbol(tag)'});
  });

  it('writes a Date as its ISO string', () => {
    expect(toJsonSafe({at: new Date(0)})).toEqual({
      at: '1970-01-01T00:00:00.000Z',
    });
  });

  it('writes a Map as a plain object and a Set as an array', () => {
    expect(
      toJsonSafe({
        m: new Map<unknown, unknown>([
          ['k', 1],
          [2, 'v'],
        ]),
        s: new Set([1, 2]),
      }),
    ).toEqual({m: {k: 1, '2': 'v'}, s: [1, 2]});
  });

  it('omits an undefined property and nulls an undefined array slot', () => {
    const coerced = toJsonSafe({gone: undefined, list: [1, undefined]});

    expect('gone' in coerced).toBe(false);
    expect(coerced['list']).toEqual([1, null]);
  });

  it('replaces a cycle with a placeholder instead of throwing', () => {
    const cyclic: Record<string, unknown> = {name: 'root'};
    cyclic['self'] = cyclic;

    expect(toJsonSafe(cyclic)).toEqual({name: 'root', self: '[Circular]'});
  });

  it('keeps the same object appearing twice without a cycle', () => {
    const shared = {a: 1};

    expect(toJsonSafe({first: shared, second: shared})).toEqual({
      first: {a: 1},
      second: {a: 1},
    });
  });

  it('recurses through nested arrays and objects', () => {
    expect(toJsonSafe({outer: [{inner: 1n}]})).toEqual({
      outer: [{inner: '1'}],
    });
  });

  it('returns a value that JSON.stringify accepts', () => {
    const coerced = toJsonSafe({
      big: 1n,
      fn: () => 1,
      when: new Date(0),
      set: new Set(['x']),
    });

    expect(JSON.parse(JSON.stringify(coerced))).toEqual({
      big: '1',
      fn: expect.any(String),
      when: '1970-01-01T00:00:00.000Z',
      set: ['x'],
    });
  });

  it('stores a __proto__ key as an own property', () => {
    const parsed: Record<string, unknown> = JSON.parse(
      '{"__proto__": {"polluted": true}}',
    );
    const coerced = toJsonSafe(parsed);

    expect(Object.keys(coerced)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(coerced)).toBe(null);
    expect({}).not.toHaveProperty('polluted');
  });

  it('detects a cycle that closes through an array', () => {
    const branch: unknown[] = [];
    const root: Record<string, unknown> = {branch};
    branch.push(root);

    expect(isJsonSafe(root)).toBe(false);
    expect(toJsonSafe(root)).toEqual({branch: ['[Circular]']});
  });
});
