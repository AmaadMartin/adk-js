/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  validateAdditionalFilter,
  validateColumnList,
  validateIdentifier,
  validateVertexAiEndpoint,
} from '../../../src/tools/spanner/sql_validation.js';

describe('validateIdentifier', () => {
  it.each([
    'documents',
    'my_schema.my_table',
    '`my_schema`.`my_table`',
    '"my_schema"."my_table"',
    '`my_schema`.my_table',
    'my_schema."my_table"',
    'embedding_col_1',
    '`my table`',
    '"my column"',
    '  documents  ',
  ])('accepts %j', (value) => {
    expect(() => validateIdentifier(value, 'table_name')).not.toThrow();
  });

  it.each([
    ['a join', 'documents JOIN admin_credentials ac ON TRUE'],
    ['a subquery', "(SELECT STRING_AGG(x, ',') FROM T) AS dump"],
    ['a semicolon', 'table; DROP TABLE users'],
    ['an empty value', ''],
    ['a line comment', 'table -- comment'],
    ['a block comment', 'table /* comment */'],
    ['a hyphen', 'my-table'],
    ['a backslash inside backticks', '`a\\`'],
    ['a backslash inside double quotes', '"a\\"'],
    ['a leading digit', '1table'],
  ])('rejects %s', (_case, value) => {
    expect(() => validateIdentifier(value, 'table_name')).toThrow(
      /Invalid SQL identifier for table_name/,
    );
  });

  it('names the parameter that carried the bad value', () => {
    expect(() =>
      validateIdentifier('a b', 'embedding_column_to_search'),
    ).toThrow(/Invalid SQL identifier for embedding_column_to_search: "a b"/);
  });
});

describe('validateColumnList', () => {
  it('accepts a list of plain column names', () => {
    expect(() =>
      validateColumnList(['col1', 'col2', 'col3'], 'columns'),
    ).not.toThrow();
  });

  it('accepts an empty list', () => {
    expect(() => validateColumnList([], 'columns')).not.toThrow();
  });

  it('rejects the list when any entry is a subquery', () => {
    expect(() =>
      validateColumnList(
        ["(SELECT STRING_AGG(x, ',') FROM T) AS dump", 'content'],
        'columns',
      ),
    ).toThrow(/Invalid SQL identifier for columns/);
  });
});

describe('validateAdditionalFilter', () => {
  it.each([
    'price_in_cents < 100000',
    "price_in_cents < 100000 AND category = 'books'",
    "price_in_cents < 100 OR category = 'books'",
    "category IN ('books', 'movies')",
    "category NOT IN ('books')",
    'price_in_cents BETWEEN 100 AND 500',
    "((price_in_cents < 100 OR category = 'books') AND status = 'active')" +
      ' OR price_in_cents > 1000',
    '1=1',
    'is_active',
    "name LIKE 'a%'",
    'deleted_at IS NULL',
    'deleted_at IS NOT NULL',
    'flag = TRUE',
    'flag = false',
    "a = 1 and b = 2 or c = 'x'",
    'price != -12.5',
    'schema.table.column >= 3',
  ])('accepts %j', (filter) => {
    expect(() => validateAdditionalFilter(filter)).not.toThrow();
  });

  it.each([
    ['a UNION', '1=1 UNION ALL SELECT password, 0.0 FROM admin_credentials'],
    ['a semicolon', '1=1; SELECT * FROM secrets'],
    ['a line comment', '1=1 -- bypass'],
    ['a block comment', '1=1 /* bypass */'],
    ['a hash comment', '1=1 # bypass'],
    ['a subquery', "1=1 OR (SELECT password FROM admin_credentials) = 'x'"],
    ['a DROP', 'DROP TABLE users'],
    ['a backslash in a value', "col = 'a\\'b'"],
    ['three levels of parentheses', '(((a = 1)))'],
    ['an unbalanced parenthesis', '(a = 1'],
    ['an empty filter', ''],
    ['a function call', 'LOWER(name) = 1'],
  ])('rejects %s', (_case, filter) => {
    expect(() => validateAdditionalFilter(filter)).toThrow(
      /additional_filter contains unsafe or unsupported patterns/,
    );
  });

  it('accepts two levels of nested parentheses', () => {
    expect(() =>
      validateAdditionalFilter("((a = 1 OR b = 2) AND c = 'x') OR d = 3"),
    ).not.toThrow();
  });
});

describe('validateVertexAiEndpoint', () => {
  it('accepts a publisher model resource name', () => {
    expect(() =>
      validateVertexAiEndpoint(
        'projects/p-1/locations/us-central1/publishers/google/models/text-embedding-005',
      ),
    ).not.toThrow();
  });

  it.each([
    ['a missing segment', 'projects/p/locations/l/models/m'],
    ['a trailing statement', "projects/p/locations/l/publishers/g/models/m'"],
    ['an empty value', ''],
    [
      'a slash in the model name',
      'projects/p/locations/l/publishers/g/models/a/b',
    ],
  ])('rejects %s', (_case, endpoint) => {
    expect(() => validateVertexAiEndpoint(endpoint)).toThrow(
      /Invalid Vertex AI endpoint format/,
    );
  });
});
