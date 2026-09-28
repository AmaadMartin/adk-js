/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {mkdtemp, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {appendCsv, toCsv} from '../../src/utils/csv_utils.js';

const COLUMNS = ['name', 'note'];

describe('toCsv', () => {
  it('writes a header row and one row per record', () => {
    const csv = toCsv([{name: 'a', note: 'b'}], COLUMNS, true);

    expect(csv).toBe('name,note\na,b\n');
  });

  it('omits the header when asked to', () => {
    const csv = toCsv([{name: 'a', note: 'b'}], COLUMNS, false);

    expect(csv).toBe('a,b\n');
  });

  it('returns an empty string for no rows and no header', () => {
    expect(toCsv([], COLUMNS, false)).toBe('');
  });

  it('quotes a field that holds a comma, a quote or a line break', () => {
    const csv = toCsv(
      [
        {name: 'a,b', note: 'say "hi"'},
        {name: 'two\nlines', note: 'plain'},
      ],
      COLUMNS,
      false,
    );

    expect(csv).toBe('"a,b","say ""hi"""\n"two\nlines",plain\n');
  });

  it('quotes a field that holds a carriage return', () => {
    expect(toCsv([{name: 'a\rb', note: ''}], COLUMNS, false)).toBe('"a\rb",\n');
  });

  it('renders a missing column, null and a number', () => {
    const csv = toCsv([{name: null, note: 7}], [...COLUMNS, 'extra'], false);

    expect(csv).toBe(',7,\n');
  });
});

describe('appendCsv', () => {
  it('creates parent directories and writes the header once', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'adk-csv-'));
    const filePath = join(workDir, 'nested', 'results.csv');

    await appendCsv(filePath, [{name: 'first', note: '1'}], COLUMNS);
    await appendCsv(filePath, [{name: 'second', note: '2'}], COLUMNS);

    expect(await readFile(filePath, 'utf-8')).toBe(
      'name,note\nfirst,1\nsecond,2\n',
    );
  });
});
