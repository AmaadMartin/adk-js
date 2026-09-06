/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  isJsonObject,
  toJsonObject,
  toJsonText,
  toJsonValue,
} from '../../src/utils/json_utils.js';

describe('toJsonText', () => {
  it('serializes a plain value', () => {
    expect(toJsonText({a: 1})).toBe('{"a":1}');
  });

  it('falls back to the string form for a circular structure', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(toJsonText(circular)).toBe('[object Object]');
  });

  it('falls back to the string form for a bigint', () => {
    expect(toJsonText(7n)).toBe('7');
  });

  it('falls back to the string form for undefined', () => {
    expect(toJsonText(undefined)).toBe('undefined');
  });
});

describe('toJsonValue', () => {
  it('copies nested structures', () => {
    expect(toJsonValue({a: [1, 'b', true], c: {d: null}})).toEqual({
      a: [1, 'b', true],
      c: {d: null},
    });
  });

  it('drops object fields JSON cannot represent', () => {
    expect(toJsonValue({a: undefined, b: () => 1, c: 1})).toEqual({c: 1});
    expect(toJsonValue(undefined)).toBeUndefined();
  });

  it('renders an unrepresentable array member as null', () => {
    expect(toJsonValue([undefined, 1])).toEqual([null, 1]);
  });

  it('rejects a circular structure', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(() => toJsonValue(circular)).toThrow(TypeError);
  });
});

describe('isJsonObject', () => {
  it('recognises plain objects', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('a')).toBe(false);
  });
});

describe('toJsonObject', () => {
  it('deep-copies an object into JSON', () => {
    const source = {a: [1, 'b'], c: {d: null}};
    const copy = toJsonObject(source);
    expect(copy).toEqual(source);
    expect(copy['c']).not.toBe(source.c);
  });

  it('drops values JSON cannot represent', () => {
    expect(toJsonObject({a: undefined, b: () => 1, c: 1})).toEqual({c: 1});
  });

  it('returns an empty object for a value that is not one', () => {
    expect(toJsonObject([1, 2])).toEqual({});
  });

  it('returns an empty object for a toJSON that yields a string', () => {
    expect(toJsonObject(new Date('2026-01-01T00:00:00Z'))).toEqual({});
  });
});
