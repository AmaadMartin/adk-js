/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from the `_escape_single_quotes`, `_is_valid_table_identifier` and
 * `_is_valid_column_identifier` cases in adk-python
 * `tests/unittests/integrations/bigquery/test_bigquery_query_tool.py`
 * (branch `main`).
 */

import {describe, expect, it} from 'vitest';
import {
  escapeSingleQuotes,
  invalidIdentifierMessage,
  isSubquery,
  isValidColumnIdentifier,
  isValidTableIdentifier,
  toIdentifierArrayLiteral,
} from '../../../src/tools/bigquery/sql_utils.js';

describe('escapeSingleQuotes', () => {
  it('escapes a single quote', () => {
    expect(escapeSingleQuotes("O'Reilly")).toBe("O\\'Reilly");
  });

  it('escapes a backslash before the quote it would otherwise consume', () => {
    expect(escapeSingleQuotes("a\\'b")).toBe("a\\\\\\'b");
  });

  it('closes the quote-injection route', () => {
    expect(escapeSingleQuotes("'; DROP TABLE users; --")).toBe(
      "\\'; DROP TABLE users; --",
    );
  });

  it('leaves text without a quote or a backslash alone', () => {
    expect(escapeSingleQuotes('SUM(sales)')).toBe('SUM(sales)');
  });
});

describe('isValidTableIdentifier', () => {
  it.each([
    'my_table_name',
    'my_project:my_dataset.my_table',
    'my-project.my-dataset.my-table',
  ])('accepts %s', (name) => {
    expect(isValidTableIdentifier(name)).toBe(true);
  });

  it.each([
    'my_table; DROP TABLE users;',
    'my_table ;',
    'my table',
    '',
    'my`table',
  ])('rejects %s', (name) => {
    expect(isValidTableIdentifier(name)).toBe(false);
  });
});

describe('isValidColumnIdentifier', () => {
  it.each(['my_column_name', 'my-column-name', 'col1'])(
    'accepts %s',
    (name) => {
      expect(isValidColumnIdentifier(name)).toBe(true);
    },
  );

  it.each([
    'my_table.my_col',
    'my_project:my_dataset.my_table',
    'my_table; DROP TABLE users;',
    '',
  ])('rejects %s', (name) => {
    expect(isValidColumnIdentifier(name)).toBe(false);
  });
});

describe('isSubquery', () => {
  it.each([
    'SELECT 1',
    '  select * from t',
    'WITH a AS (SELECT 1) SELECT * FROM a',
    '\nwith a as (select 1) select * from a',
  ])('reads %s as a query', (source) => {
    expect(isSubquery(source)).toBe(true);
  });

  it.each(['my-dataset.my-table', 'DROP TABLE t', 'sales_2024'])(
    'reads %s as a table name',
    (source) => {
      expect(isSubquery(source)).toBe(false);
    },
  );

  it('reads a table whose name starts with select as a query', () => {
    // adk-python tests the prefix, not the word, so a table named
    // `selective_table` is read as a query there too. Parity wins here: the
    // model produces the same argument for both SDKs.
    expect(isSubquery('selective_table')).toBe(true);
  });
});

describe('toIdentifierArrayLiteral', () => {
  it('renders one identifier', () => {
    expect(toIdentifierArrayLiteral(['a'])).toBe("['a']");
  });

  it('renders several identifiers', () => {
    expect(toIdentifierArrayLiteral(['a', 'b'])).toBe("['a', 'b']");
  });

  it('renders an empty list', () => {
    expect(toIdentifierArrayLiteral([])).toBe('[]');
  });
});

describe('invalidIdentifierMessage', () => {
  it('names the identifier it rejected', () => {
    expect(invalidIdentifierMessage('bad; drop')).toBe(
      'Invalid BigQuery identifier: bad; drop',
    );
  });
});
