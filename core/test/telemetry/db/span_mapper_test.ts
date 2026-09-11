/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  deserializeAttributes,
  hrTimeToUnixNanos,
  serializeAttributes,
} from '../../../src/telemetry/db/span_mapper.js';

describe('hrTimeToUnixNanos', () => {
  it('converts a timestamp above Number.MAX_SAFE_INTEGER exactly', () => {
    const nanos = hrTimeToUnixNanos([1750000000, 123456789]);

    expect(nanos).toBe('1750000000123456789');
    expect(Number(nanos)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it('converts zero', () => {
    expect(hrTimeToUnixNanos([0, 0])).toBe('0');
  });
});

describe('serializeAttributes', () => {
  it('serializes attributes to JSON', () => {
    const json = serializeAttributes({
      text: 'value',
      count: 1,
      flag: true,
      list: ['a', 'b'],
    });

    expect(JSON.parse(json)).toEqual({
      text: 'value',
      count: 1,
      flag: true,
      list: ['a', 'b'],
    });
  });

  it('falls back to an empty object when serialization throws', () => {
    const throwing = {
      toJSON() {
        throw new Error('cannot serialize');
      },
    };

    expect(serializeAttributes({throwing})).toBe('{}');
  });
});

describe('deserializeAttributes', () => {
  it('returns an empty object for empty, invalid and non-object payloads', () => {
    for (const payload of [
      undefined,
      '',
      'not valid json',
      '[]',
      'null',
      '3',
      '"text"',
    ]) {
      expect(deserializeAttributes(payload)).toEqual({});
    }
  });

  it('keeps primitives and homogeneous primitive arrays', () => {
    const json = JSON.stringify({
      text: 'value',
      count: 1,
      flag: false,
      strings: ['a', null, 'b'],
      numbers: [1, 2],
      empty: [],
    });

    expect(deserializeAttributes(json)).toEqual({
      text: 'value',
      count: 1,
      flag: false,
      strings: ['a', null, 'b'],
      numbers: [1, 2],
      empty: [],
    });
  });

  it('drops nested objects and mixed or non-primitive arrays', () => {
    const json = JSON.stringify({
      keep: 'value',
      nested: {a: 1},
      mixed: ['a', 1],
      objects: [{a: 1}],
      nulls: [null],
    });

    expect(deserializeAttributes(json)).toEqual({
      keep: 'value',
      nulls: [null],
    });
  });
});
