/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {formatAlignedTable} from '../../src/utils/table_utils.js';

describe('formatAlignedTable', () => {
  it('renders nothing for no rows', () => {
    expect(formatAlignedTable([])).toEqual([]);
  });

  it('renders a header, a rule and one line per body row', () => {
    expect(
      formatAlignedTable([
        ['a', 'b'],
        ['1', '2'],
        ['3', '4'],
      ]),
    ).toEqual(['a | b', '-----', '1 | 2', '3 | 4']);
  });

  it('widens a column to its widest cell, not its header', () => {
    const table = formatAlignedTable([
      ['name', 'score'],
      ['a_very_long_value', '1'],
    ]);

    expect(table[0]).toBe('name              | score');
    expect(table[2]).toBe('a_very_long_value | 1    ');
  });

  it('rules the table as wide as the header', () => {
    const table = formatAlignedTable([
      ['name', 'score'],
      ['a_very_long_value', '1'],
    ]);

    expect(table[1]).toBe('-'.repeat(table[0].length));
  });

  it('renders a header-only table with no body lines', () => {
    expect(formatAlignedTable([['only', 'header']])).toEqual([
      'only | header',
      '-------------',
    ]);
  });

  it('renders a blank cell for a row shorter than the header', () => {
    expect(formatAlignedTable([['a', 'b'], ['1']])).toEqual([
      'a | b',
      '-----',
      '1 |  ',
    ]);
  });

  it('cuts a row longer than the header', () => {
    expect(formatAlignedTable([['a'], ['1', '2']])).toEqual(['a', '-', '1']);
  });
});
