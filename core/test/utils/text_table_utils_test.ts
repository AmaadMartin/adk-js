/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {renderGridTable} from '../../src/utils/text_table_utils.js';

const COLUMNS = ['name', 'note'];

describe('renderGridTable', () => {
  it('renders a header, a rule above and below it, and a closing rule', () => {
    const table = renderGridTable([{name: 'ada', note: 'hi'}], COLUMNS, 25);

    expect(table).toBe(
      [
        '+------+------+',
        '| name | note |',
        '+------+------+',
        '| ada  | hi   |',
        '+------+------+',
      ].join('\n'),
    );
  });

  it('pads every column to its widest line', () => {
    const table = renderGridTable(
      [
        {name: 'ada', note: 'x'},
        {name: 'grace', note: 'y'},
      ],
      COLUMNS,
      25,
    );

    expect(table.split('\n')).toEqual([
      '+-------+------+',
      '| name  | note |',
      '+-------+------+',
      '| ada   | x    |',
      '| grace | y    |',
      '+-------+------+',
    ]);
  });

  it('wraps a cell that is wider than the column limit', () => {
    const table = renderGridTable([{name: 'abcdefgh', note: 'z'}], COLUMNS, 5);

    expect(table.split('\n')).toEqual([
      '+-------+------+',
      '| name  | note |',
      '+-------+------+',
      '| abcde | z    |',
      '| fgh   |      |',
      '+-------+------+',
    ]);
  });

  it('keeps the line breaks a cell already contains', () => {
    const table = renderGridTable([{name: 'a\nbb', note: 'z'}], COLUMNS, 25);

    expect(table.split('\n')).toEqual([
      '+------+------+',
      '| name | note |',
      '+------+------+',
      '| a    | z    |',
      '| bb   |      |',
      '+------+------+',
    ]);
  });

  it('renders an absent value as an empty cell', () => {
    const table = renderGridTable([{name: 'ada'}], COLUMNS, 25);

    expect(table).toContain('| ada  |      |');
  });

  it('renders a non-string value as text', () => {
    const table = renderGridTable([{name: 1, note: false}], COLUMNS, 25);

    expect(table).toContain('| 1    | false |');
  });

  it('renders the header alone when there are no rows', () => {
    const table = renderGridTable([], COLUMNS, 25);

    expect(table.split('\n')).toEqual([
      '+------+------+',
      '| name | note |',
      '+------+------+',
    ]);
  });

  it('wraps a column name that is wider than the column limit', () => {
    const table = renderGridTable(
      [{eval_status: 'PASSED'}],
      ['eval_status'],
      4,
    );

    expect(table.split('\n')).toEqual([
      '+------+',
      '| eval |',
      '| _sta |',
      '| tus  |',
      '+------+',
      '| PASS |',
      '| ED   |',
      '+------+',
    ]);
  });
});
