/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  rowObject,
  rowValues,
  toSerializable,
} from '../../../src/tools/spanner/result_rows.js';

describe('rowValues', () => {
  it('reads a positional row in column order', () => {
    expect(
      rowValues([
        {name: 'title', value: 'Mop'},
        {name: 'price', value: 99},
      ]),
    ).toEqual(['Mop', 99]);
  });

  it('reads a keyed row in insertion order', () => {
    expect(rowValues({title: 'Mop', price: 99})).toEqual(['Mop', 99]);
  });
});

describe('rowObject', () => {
  it('keys a positional row by column name', () => {
    expect(
      rowObject([
        {name: 'title', value: 'Mop'},
        {name: 'price', value: 99},
      ]),
    ).toEqual({title: 'Mop', price: 99});
  });

  it('copies a row that is already keyed', () => {
    const row = {title: 'Mop'};
    expect(rowObject(row)).toEqual(row);
    expect(rowObject(row)).not.toBe(row);
  });
});

describe('toSerializable', () => {
  it('returns a value JSON can carry unchanged', () => {
    const value = {title: 'Mop', price: 99};
    expect(toSerializable(value)).toBe(value);
  });

  it('renders a value JSON cannot carry', () => {
    expect(toSerializable({price: 99n})).toBe('{ price: 99n }');
  });
});
