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
    'table',
    '_table',
    'Table1',
    'my_schema.my_table',
    '`quoted table`',
    '"quoted table"',
    '`schema`.`table`',
    '  padded  ',
  ])('accepts %s', (identifier) => {
    expect(() => validateIdentifier(identifier, 'table_name')).not.toThrow();
  });

  it.each([
    '',
    '1table',
    'a.b(c)$d',
    'table; DROP TABLE x',
    'table--comment',
    '`back\\slash`',
    '"double\\quote"',
    'a..b',
    'table name',
  ])('rejects %s', (identifier) => {
    expect(() => validateIdentifier(identifier, 'table_name')).toThrow(
      /Invalid SQL identifier for table_name/,
    );
  });

  it('names the parameter and the value it rejected', () => {
    expect(() => validateIdentifier('a.b(c)$d', 'columns')).toThrow(
      "Invalid SQL identifier for columns: 'a.b(c)$d'.",
    );
  });
});

describe('validateColumnList', () => {
  it('accepts a list of identifiers', () => {
    expect(() =>
      validateColumnList(['title', 'body', 'meta.tag'], 'columns'),
    ).not.toThrow();
  });

  it('rejects the whole list when one column is unsafe', () => {
    expect(() =>
      validateColumnList(['title', 'body); DROP TABLE x --'], 'columns'),
    ).toThrow(/Invalid SQL identifier for columns/);
  });
});

describe('validateAdditionalFilter', () => {
  it.each([
    'price < 100000',
    'price <= 100000',
    'price >= 1',
    'price != 1',
    'price = -1.5',
    "name LIKE 'a%'",
    'deleted IS NULL',
    'deleted IS NOT NULL',
    'category IN (1, 2, 3)',
    "category NOT IN ('a', 'b')",
    'price BETWEEN 1 AND 10',
    'is_active',
    '1=1',
    "a = 1 AND b = 'x' OR c = TRUE",
    'a = 1 and b = 2',
    '(a = 1 OR b = 2) AND c = 3',
    '((a = 1 OR b = 2) AND c = 3) OR d = 4',
  ])('accepts %s', (filter) => {
    expect(() => validateAdditionalFilter(filter)).not.toThrow();
  });

  it.each([
    '1=1; DROP TABLE users',
    'a = 1 -- comment',
    'a = (SELECT 1)',
    "name = 'a\\'",
    '(((a = 1)))',
    'a = 1 AND',
    'DELETE FROM users',
    "name = 'x' /* comment */",
  ])('rejects %s', (filter) => {
    expect(() => validateAdditionalFilter(filter)).toThrow(
      /additional_filter contains unsafe or unsupported patterns/,
    );
  });

  it('quotes the filter it rejected', () => {
    expect(() => validateAdditionalFilter('1=1; DROP TABLE users')).toThrow(
      "additional_filter contains unsafe or unsupported patterns: '1=1; DROP TABLE users'.",
    );
  });
});

describe('validateVertexAiEndpoint', () => {
  it('accepts a fully qualified endpoint', () => {
    expect(() =>
      validateVertexAiEndpoint(
        'projects/my-project/locations/us-central1/publishers/google/models/text-embedding-005',
      ),
    ).not.toThrow();
  });

  it.each([
    'text-embedding-005',
    'projects/my-project/locations/us-central1/models/text-embedding-005',
    'projects//locations/us-central1/publishers/google/models/m',
    'projects/p/locations/l/publishers/google/models/m/extra',
  ])('rejects %s', (endpoint) => {
    expect(() => validateVertexAiEndpoint(endpoint)).toThrow(
      /Invalid Vertex AI endpoint format/,
    );
  });
});
