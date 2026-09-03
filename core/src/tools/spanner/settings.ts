/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Vector similarity search using exhaustive k-nearest-neighbour scanning. */
export const EXACT_NEAREST_NEIGHBORS = 'EXACT_NEAREST_NEIGHBORS';

/** Vector similarity search using a vector index. */
export const APPROXIMATE_NEAREST_NEIGHBORS = 'APPROXIMATE_NEAREST_NEIGHBORS';

/** The algorithms {@link SpannerVectorStoreSettings} accepts. */
export type NearestNeighborsAlgorithm =
  | typeof EXACT_NEAREST_NEIGHBORS
  | typeof APPROXIMATE_NEAREST_NEIGHBORS;

/** What kind of operation the Spanner tools may perform. */
export enum Capabilities {
  /** Read-only data operations are allowed. */
  DATA_READ = 'data_read',
}

/** How `spanner_execute_sql` shapes each row it returns. */
export enum QueryResultMode {
  /** Each row is the list of its column values. */
  DEFAULT = 'default',
  /** Each row is an object keyed by column name. */
  DICT_LIST = 'dict_list',
}

/** One column of a vector store table. */
export interface TableColumn {
  /** The name of the column. */
  name: string;
  /**
   * The type of the column, e.g. `STRING(MAX)` or `INT64` for GoogleSQL, and
   * `text` or `int8` for PostgreSQL.
   */
  type: string;
  /** Whether the column is nullable. Defaults to `true`. */
  isNullable?: boolean;
}

/** The vector index an approximate nearest neighbour search reads. */
export interface VectorSearchIndexSettings {
  /** The name of the vector similarity search index. */
  indexName: string;
  /** Extra key columns in the index, after the embedding column. */
  additionalKeyColumns?: string[];
  /** Columns the index stores, so filtering can drop rows while walking it. */
  additionalStoringColumns?: string[];
  /** The tree depth, either 2 or 3. Defaults to 2. */
  treeDepth?: number;
  /** The number of leaves the vector data is partitioned into. Defaults to 1000. */
  numLeaves?: number;
  /** The number of branches, for a tree of depth 3 only. */
  numBranches?: number;
}

/**
 * The vector store table `spanner_vector_store_similarity_search` searches.
 *
 * Setting this on {@link SpannerToolSettings} is what adds that tool to the
 * toolset: without it there is no table to search.
 */
export interface SpannerVectorStoreSettings {
  /** The Google Cloud project id the Spanner database is in. */
  projectId: string;
  /** The Spanner instance id. */
  instanceId: string;
  /** The Spanner database id. */
  databaseId: string;
  /** The name of the vector store table. */
  tableName: string;
  /** The name of the content column, returned by default. */
  contentColumn: string;
  /** The name of the embedding column that is searched. */
  embeddingColumn: string;
  /** The dimension of the vectors in {@link embeddingColumn}. */
  vectorLength: number;
  /** The Vertex AI embedding model name, e.g. `text-embedding-005`. */
  vertexAiEmbeddingModelName: string;
  /** Columns to return. Defaults to `[contentColumn]`. */
  selectedColumns?: string[];
  /** The search algorithm. Defaults to {@link EXACT_NEAREST_NEIGHBORS}. */
  nearestNeighborsAlgorithm?: NearestNeighborsAlgorithm;
  /** How many neighbours to return. Defaults to 4. */
  topK?: number;
  /** `COSINE`, `DOT_PRODUCT` or `EUCLIDEAN`. Defaults to `COSINE`. */
  distanceType?: string;
  /** How many leaves of the index to search, for an approximate search only. */
  numLeavesToSearch?: number;
  /** An extra condition added to the `WHERE` clause of the search. */
  additionalFilter?: string;
  /** The vector index, required for an approximate search. */
  vectorSearchIndexSettings?: VectorSearchIndexSettings;
  /** Extra columns to create when a new vector store table is set up. */
  additionalColumnsToSetup?: TableColumn[];
  /** The primary key of a new vector store table. Defaults to a generated `id`. */
  primaryKeyColumns?: string[];
}

/**
 * {@link SpannerVectorStoreSettings} after
 * {@link resolveVectorStoreSettings} has checked it and filled in the columns
 * the search returns.
 */
export type ResolvedVectorStoreSettings = SpannerVectorStoreSettings & {
  selectedColumns: string[];
};

/** Settings for the Spanner tools. */
export interface SpannerToolSettings {
  /**
   * What the tools may do. Defaults to `[Capabilities.DATA_READ]`, which adds
   * the query and search tools; `[]` leaves only the metadata tools.
   */
  capabilities?: Capabilities[];
  /** How many rows `spanner_execute_sql` returns. Defaults to 50. */
  maxExecutedQueryResultRows?: number;
  /** How `spanner_execute_sql` shapes a row. Defaults to `DEFAULT`. */
  queryResultMode?: QueryResultMode;
  /** The database role the Spanner session runs as. */
  databaseRole?: string;
  /** The vector store table, which adds `spanner_vector_store_similarity_search`. */
  vectorStoreSettings?: SpannerVectorStoreSettings;
}

/** The row budget `spanner_execute_sql` uses when the setting is unusable. */
export const DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS = 50;

/**
 * Checks the vector store settings and fills in the columns the search
 * returns, matching adk-python's `SpannerVectorStoreSettings` validator.
 *
 * @param settings The settings as the developer wrote them.
 * @return The settings with {@link SpannerVectorStoreSettings.selectedColumns}
 *   set.
 * @throws Error if the vector length is not positive, or if a primary key
 *   column is not one of the columns the table defines.
 */
export function resolveVectorStoreSettings(
  settings: SpannerVectorStoreSettings,
): ResolvedVectorStoreSettings {
  if (!settings.vectorLength || settings.vectorLength <= 0) {
    throw new Error(
      'Invalid vector length in the Spanner vector store settings.',
    );
  }

  const columns = new Set([settings.contentColumn, settings.embeddingColumn]);
  for (const column of settings.additionalColumnsToSetup ?? []) {
    columns.add(column.name);
  }
  for (const primaryKey of settings.primaryKeyColumns ?? []) {
    if (!columns.has(primaryKey)) {
      throw new Error(
        `Primary key column '${primaryKey}' not found in column definitions.`,
      );
    }
  }

  const selectedColumns = settings.selectedColumns?.length
    ? settings.selectedColumns
    : [settings.contentColumn];
  return {...settings, selectedColumns};
}
