/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {toJsonSerializable} from '../../src/utils/json_utils.js';

describe('toJsonSerializable', () => {
  it('returns plain values unchanged', () => {
    const value = {a: 1, b: [1, 2], c: {d: 'e'}, f: null, g: true};
    expect(toJsonSerializable(value)).toEqual(value);
  });

  it('returns a primitive unchanged', () => {
    expect(toJsonSerializable('text')).toBe('text');
    expect(toJsonSerializable(7)).toBe(7);
    expect(toJsonSerializable(false)).toBe(false);
    expect(toJsonSerializable(null)).toBeNull();
    expect(toJsonSerializable(undefined)).toBeUndefined();
  });

  it('converts a Date through toJSON instead of discarding it', () => {
    const date = new Date('2024-01-02T03:04:05.000Z');
    expect(toJsonSerializable(date)).toBe('2024-01-02T03:04:05.000Z');
  });

  it('converts nested rich types in place', () => {
    const result = toJsonSerializable({
      when: new Date('2024-05-06T00:00:00.000Z'),
      n: [1],
    });
    expect(result).toEqual({when: '2024-05-06T00:00:00.000Z', n: [1]});
  });

  it('replaces a function with a string naming it', () => {
    function namedCallback() {
      return 1;
    }
    expect(toJsonSerializable(namedCallback)).toBe('[Function: namedCallback]');
  });

  it('names an unnamed function anonymous', () => {
    const anonymous = {run: function () {}};
    Object.defineProperty(anonymous.run, 'name', {value: ''});
    expect(toJsonSerializable(anonymous)).toEqual({
      run: '[Function: anonymous]',
    });
  });

  it('replaces a nested function and keeps its siblings', () => {
    const result = toJsonSerializable({cb: () => 1, ok: 2});
    expect(result).toEqual({cb: expect.stringContaining('Function'), ok: 2});
  });

  it('replaces a bigint with its decimal string', () => {
    expect(toJsonSerializable({big: 9007199254740993n})).toEqual({
      big: '9007199254740993',
    });
  });

  it('replaces a symbol with its description', () => {
    expect(toJsonSerializable({sym: Symbol('token')})).toEqual({
      sym: 'Symbol(token)',
    });
  });

  it('replaces a circular reference', () => {
    const cycle: Record<string, unknown> = {name: 'root'};
    cycle['self'] = cycle;
    expect(toJsonSerializable(cycle)).toEqual({
      name: 'root',
      self: '[Circular]',
    });
  });

  it('keeps a value repeated in two places rather than calling it circular', () => {
    const shared = {n: 1};
    expect(toJsonSerializable({a: shared, b: shared})).toEqual({
      a: {n: 1},
      b: {n: 1},
    });
  });

  it('replaces a toJSON that returns the object itself', () => {
    const selfReferential = {
      toJSON() {
        return selfReferential;
      },
    };
    expect(toJsonSerializable(selfReferential)).toBe('[Circular]');
  });

  it('converts array entries and replaces an unserializable one', () => {
    let replacements = 0;
    const result = toJsonSerializable({items: [1, () => 2]}, () => {
      replacements++;
    });
    expect(result).toEqual({items: [1, expect.stringContaining('Function')]});
    expect(replacements).toBe(1);
  });

  it('omits an undefined property, matching JSON.stringify', () => {
    expect(toJsonSerializable({a: undefined, b: 1})).toEqual({b: 1});
    expect(
      Object.keys(toJsonSerializable({a: undefined, b: 1}) as object),
    ).toEqual(['b']);
  });

  it('produces output that JSON.stringify accepts', () => {
    const cycle: Record<string, unknown> = {big: 1n, sym: Symbol('s')};
    cycle['self'] = cycle;
    expect(() => JSON.stringify(toJsonSerializable(cycle))).not.toThrow();
  });

  it('reports once for every replaced value, however deeply nested', () => {
    let replacements = 0;
    toJsonSerializable({cb: () => 1, nested: {cb: () => 2, ok: 3}}, () => {
      replacements++;
    });
    expect(replacements).toBe(2);
  });

  it('reports a replaced top-level value', () => {
    let replacements = 0;
    toJsonSerializable(
      () => 1,
      () => {
        replacements++;
      },
    );
    expect(replacements).toBe(1);
  });

  it('does not report anything for a fully serializable value', () => {
    let replacements = 0;
    toJsonSerializable({a: 1, b: {c: [true, null]}}, () => {
      replacements++;
    });
    expect(replacements).toBe(0);
  });
});
