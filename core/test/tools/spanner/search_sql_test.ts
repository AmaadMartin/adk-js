/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  generateSqlForAnn,
  generateSqlForKnn,
  ResolvedSearchOptions,
  SearchQuery,
} from '../../../src/tools/spanner/search_sql.js';

const QUERY: SearchQuery = {
  tableName: 'documents',
  embeddingColumn: 'embedding',
  columns: ['title', 'body'],
};

const OPTIONS: ResolvedSearchOptions = {
  distanceType: 'COSINE',
  topK: 4,
  algorithm: 'EXACT_NEAREST_NEIGHBORS',
  numLeavesToSearch: 1000,
};

/** The generated SQL with its whitespace collapsed, so it can be matched. */
function sql(generated: string): string {
  return generated.replace(/\s+/g, ' ').trim();
}

describe('generateSqlForKnn', () => {
  it('generates a GoogleSQL query', () => {
    expect(sql(generateSqlForKnn('GOOGLE_STANDARD_SQL', QUERY, OPTIONS))).toBe(
      'SELECT title, body, COSINE_DISTANCE(embedding, @embedding) AS distance ' +
        'FROM documents WHERE 1=1 ORDER BY distance LIMIT 4',
    );
  });

  it('generates a PostgreSQL query with a positional parameter', () => {
    expect(sql(generateSqlForKnn('POSTGRESQL', QUERY, OPTIONS))).toBe(
      'SELECT title, body, spanner.cosine_distance(embedding, $1) AS distance ' +
        'FROM documents WHERE 1=1 ORDER BY distance LIMIT 4',
    );
  });

  it.each([
    ['EUCLIDEAN', 'EUCLIDEAN_DISTANCE'],
    ['DOT_PRODUCT', 'DOT_PRODUCT'],
  ])('uses the GoogleSQL %s distance function', (distanceType, expected) => {
    expect(
      sql(
        generateSqlForKnn('GOOGLE_STANDARD_SQL', QUERY, {
          ...OPTIONS,
          distanceType,
        }),
      ),
    ).toContain(`${expected}(embedding, @embedding)`);
  });

  it.each([
    ['EUCLIDEAN', 'spanner.euclidean_distance'],
    ['DOT_PRODUCT', 'spanner.dot_product'],
  ])('uses the PostgreSQL %s distance function', (distanceType, expected) => {
    expect(
      sql(generateSqlForKnn('POSTGRESQL', QUERY, {...OPTIONS, distanceType})),
    ).toContain(`${expected}(embedding, $1)`);
  });

  it('omits the limit for a top k of zero', () => {
    expect(
      sql(
        generateSqlForKnn('GOOGLE_STANDARD_SQL', QUERY, {
          ...OPTIONS,
          topK: 0,
        }),
      ),
    ).not.toContain('LIMIT');
  });

  it('puts an additional filter in the where clause', () => {
    expect(
      sql(
        generateSqlForKnn(
          'GOOGLE_STANDARD_SQL',
          {...QUERY, additionalFilter: 'price < 100000'},
          OPTIONS,
        ),
      ),
    ).toContain('WHERE price < 100000 ORDER BY distance');
  });

  it('rejects a distance metric Spanner does not support', () => {
    expect(() =>
      generateSqlForKnn('GOOGLE_STANDARD_SQL', QUERY, {
        ...OPTIONS,
        distanceType: 'MANHATTAN',
      }),
    ).toThrow('Unsupported distance type: MANHATTAN.');
  });
});

describe('generateSqlForAnn', () => {
  it('generates a GoogleSQL query that reads the vector index', () => {
    expect(
      sql(
        generateSqlForAnn('GOOGLE_STANDARD_SQL', QUERY, {
          ...OPTIONS,
          topK: 3,
          numLeavesToSearch: 40,
        }),
      ),
    ).toBe(
      'SELECT title, body, APPROX_COSINE_DISTANCE(embedding, @embedding,' +
        ' options => JSON \'{"num_leaves_to_search": 40}\') AS distance ' +
        'FROM documents WHERE embedding IS NOT NULL ORDER BY distance LIMIT 3',
    );
  });

  it.each([
    ['EUCLIDEAN', 'APPROX_EUCLIDEAN_DISTANCE'],
    ['DOT_PRODUCT', 'APPROX_DOT_PRODUCT'],
  ])('uses the approximate %s distance function', (distanceType, expected) => {
    expect(
      sql(
        generateSqlForAnn('GOOGLE_STANDARD_SQL', QUERY, {
          ...OPTIONS,
          distanceType,
        }),
      ),
    ).toContain(`${expected}(embedding, @embedding,`);
  });

  it('guards the embedding column and keeps an additional filter', () => {
    expect(
      sql(
        generateSqlForAnn(
          'GOOGLE_STANDARD_SQL',
          {...QUERY, additionalFilter: 'price < 100000'},
          OPTIONS,
        ),
      ),
    ).toContain('WHERE embedding IS NOT NULL AND price < 100000');
  });

  it('rejects a PostgreSQL database', () => {
    expect(() => generateSqlForAnn('POSTGRESQL', QUERY, OPTIONS)).toThrow(
      'APPROXIMATE_NEAREST_NEIGHBORS is not supported for PostgreSQL dialect.',
    );
  });

  it('rejects a distance metric Spanner does not support', () => {
    expect(() =>
      generateSqlForAnn('GOOGLE_STANDARD_SQL', QUERY, {
        ...OPTIONS,
        distanceType: 'MANHATTAN',
      }),
    ).toThrow('Unsupported distance type: MANHATTAN.');
  });
});
