/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {toJsonSafe} from '../../src/utils/json_utils.js';

/** The coerced record alone, for assertions that do not care about loss. */
function record(input: Record<string, unknown>): Record<string, unknown> {
  return toJsonSafe(input).record;
}

/** Whether `JSON.stringify` alone would have represented `record` intact. */
function lossless(record: Record<string, unknown>): boolean {
  return !toJsonSafe(record).lossy;
}

describe('the lossy signal', () => {
  it('accepts values JSON represents faithfully', () => {
    expect(lossless({a: 1, b: 'two', c: true, d: null})).toBe(true);
    expect(lossless({nested: [1, [2, {three: 3}]]})).toBe(true);
    expect(lossless({at: new Date(0)})).toBe(true);
  });

  it('accepts an undefined property, which JSON omits by design', () => {
    expect(lossless({a: undefined})).toBe(true);
  });

  it('rejects a bigint, which JSON.stringify throws on', () => {
    expect(lossless({a: 1n})).toBe(false);
  });

  it('rejects a function and a symbol, which JSON.stringify drops', () => {
    expect(lossless({a: () => 1})).toBe(false);
    expect(lossless({a: Symbol('s')})).toBe(false);
  });

  it('rejects a Map and a Set, which JSON.stringify writes as {}', () => {
    expect(lossless({a: new Map([['k', 'v']])})).toBe(false);
    expect(lossless({a: new Set([1])})).toBe(false);
  });

  it('rejects a cycle, which JSON.stringify throws on', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    expect(lossless(cyclic)).toBe(false);
  });

  it('rejects an unsafe value nested in an array', () => {
    expect(lossless({list: [1, 2n]})).toBe(false);
  });

  it('accepts the same object appearing twice without a cycle', () => {
    const shared = {a: 1};

    expect(lossless({first: shared, second: shared})).toBe(true);
  });
});

describe('toJsonSafe', () => {
  it('leaves primitives untouched', () => {
    expect(record({a: 1, b: 'two', c: false, d: null})).toEqual({
      a: 1,
      b: 'two',
      c: false,
      d: null,
    });
  });

  it('replaces a bigint with its string form', () => {
    expect(record({a: 10n})).toEqual({a: '10'});
  });

  it('replaces a function with its string form rather than dropping it', () => {
    const coerced = record({callback: function named() {}});

    expect(typeof coerced['callback']).toBe('string');
    expect(coerced['callback']).toContain('named');
  });

  it('replaces a symbol with its string form', () => {
    expect(record({a: Symbol('tag')})).toEqual({a: 'Symbol(tag)'});
  });

  it('writes a Date as its ISO string', () => {
    expect(record({at: new Date(0)})).toEqual({
      at: '1970-01-01T00:00:00.000Z',
    });
  });

  it('writes a Map as a plain object and a Set as an array', () => {
    expect(
      record({
        m: new Map<unknown, unknown>([
          ['k', 1],
          [2, 'v'],
        ]),
        s: new Set([1, 2]),
      }),
    ).toEqual({m: {k: 1, '2': 'v'}, s: [1, 2]});
  });

  it('omits an undefined property and nulls an undefined array slot', () => {
    const coerced = record({gone: undefined, list: [1, undefined]});

    expect('gone' in coerced).toBe(false);
    expect(coerced['list']).toEqual([1, null]);
  });

  it('replaces a cycle with a placeholder instead of throwing', () => {
    const cyclic: Record<string, unknown> = {name: 'root'};
    cyclic['self'] = cyclic;

    expect(record(cyclic)).toEqual({name: 'root', self: '[Circular]'});
  });

  it('keeps the same object appearing twice without a cycle', () => {
    const shared = {a: 1};

    expect(record({first: shared, second: shared})).toEqual({
      first: {a: 1},
      second: {a: 1},
    });
  });

  it('recurses through nested arrays and objects', () => {
    expect(record({outer: [{inner: 1n}]})).toEqual({
      outer: [{inner: '1'}],
    });
  });

  it('returns a value that JSON.stringify accepts', () => {
    const coerced = record({
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
    const coerced = record(parsed);

    expect(Object.keys(coerced)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(coerced)).toBe(null);
    expect({}).not.toHaveProperty('polluted');
  });

  it('detects a cycle that closes through an array', () => {
    const branch: unknown[] = [];
    const root: Record<string, unknown> = {branch};
    branch.push(root);

    expect(lossless(root)).toBe(false);
    expect(record(root)).toEqual({branch: ['[Circular]']});
  });
});
