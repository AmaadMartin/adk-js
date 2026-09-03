/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  toJsonSafe,
  toValueRow,
} from '../../../src/tools/spanner/result_rows.js';

describe('toValueRow', () => {
  it('reads the values of a field row in order', () => {
    const row = [
      {name: 'name', value: 'The Hotel'},
      {name: 'rating', value: 4.1},
    ];

    expect(toValueRow(row)).toEqual(['The Hotel', 4.1]);
  });

  it('reads the values of a row the client already keyed', () => {
    expect(toValueRow({name: 'The Hotel', rating: 4.1})).toEqual([
      'The Hotel',
      4.1,
    ]);
  });

  it('reads an empty row as no values', () => {
    expect(toValueRow([])).toEqual([]);
  });
});

describe('toJsonSafe', () => {
  it('returns a row JSON can serialize unchanged', () => {
    const row = {name: 'The Hotel', rating: 4.1};

    expect(toJsonSafe(row)).toBe(row);
  });

  it('renders a row carrying a BigInt', () => {
    expect(toJsonSafe({count: 12n})).toBe('{ count: 12n }');
  });

  it('renders a row that refers to itself', () => {
    const row: Record<string, unknown> = {name: 'a'};
    row.self = row;

    expect(toJsonSafe(row)).toContain('[Circular');
  });
});
