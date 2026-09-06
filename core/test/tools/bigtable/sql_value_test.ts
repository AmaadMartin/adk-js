/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  fieldName,
  isNamedValues,
  namedValuesToJson,
  toJsonValue,
} from '../../../src/tools/bigtable/sql_value.js';

/** A struct or row, shaped as the Bigtable SDK's `NamedList` is. */
function named(fields: Array<[string | null, unknown]>) {
  return {
    values: fields.map(([, value]) => value),
    fieldMapping: {fieldNames: fields.map(([name]) => name)},
  };
}

describe('toJsonValue', () => {
  it('keeps values JSON already carries', () => {
    expect(toJsonValue('alice')).toBe('alice');
    expect(toJsonValue(7)).toBe(7);
    expect(toJsonValue(true)).toBe(true);
  });

  it('reports a missing value as null', () => {
    expect(toJsonValue(null)).toBeNull();
    expect(toJsonValue(undefined)).toBeNull();
  });

  it('keeps every digit of a 64-bit integer by writing it as a string', () => {
    expect(toJsonValue(9007199254740993n)).toBe('9007199254740993');
  });

  it('encodes a byte string as base64', () => {
    expect(toJsonValue(new Uint8Array([104, 105]))).toBe('aGk=');
  });

  it('encodes only the bytes a view covers', () => {
    const view = new Uint8Array([0, 0, 104, 105]).subarray(2);

    expect(toJsonValue(view)).toBe('aGk=');
  });

  it('writes a timestamp as an ISO instant', () => {
    expect(toJsonValue(new Date('2026-01-02T03:04:05.000Z'))).toBe(
      '2026-01-02T03:04:05.000Z',
    );
  });

  it('converts every element of an array', () => {
    expect(toJsonValue([1n, 'two', null])).toEqual(['1', 'two', null]);
  });

  it('converts a map into an object keyed by its stringified keys', () => {
    const map = new Map<unknown, unknown>([
      ['a', 1n],
      [2, 'b'],
    ]);

    expect(toJsonValue(map)).toEqual({a: '1', '2': 'b'});
  });

  it('converts a map value that implements Map without extending it', () => {
    // The SDK returns a map column as `EncodedKeyMap`, which wraps a private
    // `Map` rather than extending it, so `instanceof Map` is false for it.
    const encodedKeyMap = {
      inner: new Map<unknown, unknown>([['user', 1n]]),
      entries() {
        return this.inner.entries();
      },
    };

    expect(encodedKeyMap instanceof Map).toBe(false);
    expect(toJsonValue(encodedKeyMap)).toEqual({user: '1'});
  });

  it('converts a timestamp subclass the SDK returns', () => {
    // The SDK returns a timestamp column as `PreciseDate`, a `Date` subclass.
    class PreciseDateStub extends Date {}

    expect(toJsonValue(new PreciseDateStub('2026-01-02T03:04:05.000Z'))).toBe(
      '2026-01-02T03:04:05.000Z',
    );
  });

  it('converts a struct into an object of its named fields', () => {
    expect(
      toJsonValue(
        named([
          ['name', 'alice'],
          ['age', 30n],
        ]),
      ),
    ).toEqual({
      name: 'alice',
      age: '30',
    });
  });

  it('converts a plain object such as a SQL date', () => {
    expect(toJsonValue({year: 2026, month: 1, day: 2})).toEqual({
      year: 2026,
      month: 1,
      day: 2,
    });
  });

  it('falls back to the string form of a value JSON cannot carry', () => {
    expect(toJsonValue(Symbol('token'))).toBe('Symbol(token)');
  });
});

describe('fieldName', () => {
  it('uses the column name the query gave', () => {
    expect(fieldName(['user_id'], 0)).toBe('user_id');
  });

  it('names an unnamed column after its index', () => {
    expect(fieldName([null], 0)).toBe('_0');
    expect(fieldName([''], 0)).toBe('_0');
  });

  it('keeps a repeated column name distinct by its index', () => {
    expect(fieldName(['count', 'count'], 0)).toBe('count');
    expect(fieldName(['count', 'count'], 1)).toBe('count_1');
  });
});

describe('isNamedValues', () => {
  it('accepts a struct or row', () => {
    expect(isNamedValues(named([['a', 1]]))).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isNamedValues(null)).toBe(false);
    expect(isNamedValues('row')).toBe(false);
    expect(isNamedValues({values: [1]})).toBe(false);
    expect(isNamedValues({values: [1], fieldMapping: null})).toBe(false);
    expect(isNamedValues({values: [1], fieldMapping: {}})).toBe(false);
  });
});

describe('namedValuesToJson', () => {
  it('loses no value when two columns share a name', () => {
    expect(
      namedValuesToJson(
        named([
          ['n', 1],
          ['n', 2],
          [null, 3],
        ]),
      ),
    ).toEqual({n: 1, n_1: 2, _2: 3});
  });
});
