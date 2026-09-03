/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The SQL a vector similarity search runs.
 *
 * This answers one question: given a dialect, a search algorithm and a
 * distance metric, what query does Spanner receive? The identifiers it
 * concatenates are checked by `sql_validation.ts` before they reach here.
 */

import {POSTGRESQL_DIALECT} from './client.js';
import {APPROXIMATE_NEAREST_NEIGHBORS} from './settings.js';

/** The column the distance is returned as. */
export const DISTANCE_ALIAS = 'distance';

/** The query parameter carrying the search text, in a GoogleSQL database. */
export const GOOGLESQL_TEXT_QUERY_PARAMETER = 'query';

/** The query parameter carrying the search text, in a PostgreSQL database. */
export const POSTGRESQL_TEXT_QUERY_PARAMETER = '1';

/** The query parameter carrying the embedding, in a GoogleSQL database. */
export const GOOGLESQL_EMBEDDING_PARAMETER = 'embedding';

/** The query parameter carrying the embedding, in a PostgreSQL database. */
export const POSTGRESQL_EMBEDDING_PARAMETER = '1';

const POSTGRESQL_DISTANCE_FUNCTIONS: Record<string, string> = {
  COSINE: 'spanner.cosine_distance',
  EUCLIDEAN: 'spanner.euclidean_distance',
  DOT_PRODUCT: 'spanner.dot_product',
};

const GOOGLESQL_DISTANCE_FUNCTIONS: Record<string, string> = {
  COSINE: 'COSINE_DISTANCE',
  EUCLIDEAN: 'EUCLIDEAN_DISTANCE',
  DOT_PRODUCT: 'DOT_PRODUCT',
};

const GOOGLESQL_APPROXIMATE_DISTANCE_FUNCTIONS: Record<string, string> = {
  COSINE: 'APPROX_COSINE_DISTANCE',
  EUCLIDEAN: 'APPROX_EUCLIDEAN_DISTANCE',
  DOT_PRODUCT: 'APPROX_DOT_PRODUCT',
};

/** What is being searched, once the arguments have been validated. */
export interface SearchQuery {
  tableName: string;
  embeddingColumn: string;
  columns: string[];
  additionalFilter?: string;
}

/** How the search is parameterized, once the options have been read. */
export interface ResolvedSearchOptions {
  distanceType: string;
  topK: number;
  algorithm: string;
  numLeavesToSearch: number;
}

/** Looks up a distance function, naming the unsupported metric on failure. */
function distanceFunction(
  functions: Record<string, string>,
  distanceType: string,
): string {
  const name = functions[distanceType];
  if (!name) {
    throw new Error(`Unsupported distance type: ${distanceType}.`);
  }
  return name;
}

/**
 * Generates the SQL for an exhaustive (kNN) vector search.
 *
 * @param dialect The dialect of the target database.
 * @param query What is being searched.
 * @param options The distance metric and the neighbor count.
 * @throws If the distance metric is not one Spanner supports.
 */
export function generateSqlForKnn(
  dialect: string,
  query: SearchQuery,
  options: ResolvedSearchOptions,
): string {
  const isPostgresql = dialect === POSTGRESQL_DIALECT;
  const distance = distanceFunction(
    isPostgresql ? POSTGRESQL_DISTANCE_FUNCTIONS : GOOGLESQL_DISTANCE_FUNCTIONS,
    options.distanceType,
  );
  const parameter = isPostgresql
    ? `$${POSTGRESQL_EMBEDDING_PARAMETER}`
    : `@${GOOGLESQL_EMBEDDING_PARAMETER}`;
  const columns = [
    ...query.columns,
    `${distance}(${query.embeddingColumn}, ${parameter}) AS ${DISTANCE_ALIAS}`,
  ].join(', ');
  const limit = options.topK > 0 ? `\n    LIMIT ${options.topK}` : '';
  return `
    SELECT ${columns}
    FROM ${query.tableName}
    WHERE ${query.additionalFilter ?? '1=1'}
    ORDER BY ${DISTANCE_ALIAS}${limit}
  `;
}

/**
 * Generates the SQL for an approximate (ANN) vector search, which reads a
 * vector index instead of scanning the table.
 *
 * @param dialect The dialect of the target database.
 * @param query What is being searched.
 * @param options The distance metric, the neighbor count and the leaf count.
 * @throws If the database is PostgreSQL, or if the distance metric is not one
 *   Spanner supports.
 */
export function generateSqlForAnn(
  dialect: string,
  query: SearchQuery,
  options: ResolvedSearchOptions,
): string {
  if (dialect === POSTGRESQL_DIALECT) {
    throw new Error(
      `${APPROXIMATE_NEAREST_NEIGHBORS} is not supported for PostgreSQL dialect.`,
    );
  }
  const distance = distanceFunction(
    GOOGLESQL_APPROXIMATE_DISTANCE_FUNCTIONS,
    options.distanceType,
  );
  const searchOptions = `JSON '{"num_leaves_to_search": ${options.numLeavesToSearch}}'`;
  const columns = [
    ...query.columns,
    `${distance}(${query.embeddingColumn}, @${GOOGLESQL_EMBEDDING_PARAMETER},` +
      ` options => ${searchOptions}) AS ${DISTANCE_ALIAS}`,
  ].join(', ');
  const filter = query.additionalFilter
    ? `${query.embeddingColumn} IS NOT NULL AND ${query.additionalFilter}`
    : `${query.embeddingColumn} IS NOT NULL`;
  return `
    SELECT ${columns}
    FROM ${query.tableName}
    WHERE ${filter}
    ORDER BY ${DISTANCE_ALIAS}
    LIMIT ${options.topK}
  `;
}
