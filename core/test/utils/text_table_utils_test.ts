/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {formatTable} from '../../src/utils/text_table_utils.js';

describe('formatTable', () => {
  it('pads every column to its widest cell', () => {
    const table = formatTable(
      [
        {name: 'roll_die', score: 1},
        {name: 'x', score: 0.5},
      ],
      ['name', 'score'],
    );

    expect(table).toBe(
      'name      score\n--------  -----\nroll_die  1\nx         0.5',
    );
  });

  it('renders a header alone when there are no rows', () => {
    expect(formatTable([], ['name'])).toBe('name\n----');
  });

  it('flattens a cell that spans lines', () => {
    expect(formatTable([{note: 'a\nb'}], ['note'])).toBe('note\n----\na b');
  });

  it('cuts a cell short once it is wider than the limit', () => {
    const table = formatTable([{note: 'x'.repeat(40)}], ['note']);

    expect(table.split('\n')[2]).toBe(`${'x'.repeat(22)}...`);
  });

  it('renders a missing column and a null as empty', () => {
    expect(formatTable([{note: null}], ['note', 'other'])).toBe(
      'note  other\n----  -----\n',
    );
  });
});
