/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  isFeatureEnabled,
} from '../../features/feature_registry.js';

/** Exact nearest neighbors vector similarity search algorithm. */
export const EXACT_NEAREST_NEIGHBORS = 'EXACT_NEAREST_NEIGHBORS';

/** Approximate nearest neighbors vector similarity search algorithm. */
export const APPROXIMATE_NEAREST_NEIGHBORS = 'APPROXIMATE_NEAREST_NEIGHBORS';

/** Vector similarity search nearest neighbors search algorithms. */
export type NearestNeighborsAlgorithm =
  | typeof EXACT_NEAREST_NEIGHBORS
  | typeof APPROXIMATE_NEAREST_NEIGHBORS;

/**
 * Capabilities indicating what type of operation tools are allowed to be
 * performed on Spanner.
 */
export enum Capabilities {
  /** Read only data operations tools are allowed. */
  DATA_READ = 'data_read',
}

/** Settings for Spanner execute sql query result. */
export enum QueryResultMode {
  /** Return the result of a query as a list of rows data. */
  DEFAULT = 'default',

  /**
   * Return the result of a query as a list of dictionaries.
   *
   * In each dictionary the key is the column name and the value is the value
   * of the that column in a given row.
   */
  DICT_LIST = 'dict_list',
}

/**
 * Represents column configuration, to be used as part of create DDL statement
 * for a new vector store table set up.
 */
export interface TableColumn {
  /** Required. The name of the column. */
  name: string;

  /**
   * Required. The type of the column.
   *
   * For example,
   *
   * - GoogleSQL: 'STRING(MAX)', 'INT64', 'FLOAT64', 'BOOL', etc.
   * - PostgreSQL: 'text', 'int8', 'float8', 'boolean', etc.
   */
  type: string;

  /**
   * Optional. Whether the column is nullable. By default, the column is
   * nullable.
   */
  isNullable?: boolean;
}

/**
 * Settings for the index for use with Approximate Nearest Neighbor (ANN)
 * vector similarity search.
 */
export interface VectorSearchIndexSettings {
  /** Required. The name of the vector similarity search index. */
  indexName: string;

  /**
   * Optional. The list of the additional key column names in the vector
   * similarity search index.
   *
   * To further speed up filtering for highly selective filtering columns,
   * organize them as additional keys in the vector index after the embedding
   * column. For example: `category` as additional key column.
   * `CREATE VECTOR INDEX ON documents(embedding, category);`
   */
  additionalKeyColumns?: string[];

  /**
   * Optional. The list of the storing column names in the vector similarity
   * search index.
   *
   * This enables filtering while walking the vector index, removing
   * unqualified rows early. For example: `category` as storing column.
   * `CREATE VECTOR INDEX ON documents(embedding) STORING (category);`
   */
  additionalStoringColumns?: string[];

  /**
   * The tree depth (level). This value can be either 2 or 3. Defaults to 2.
   *
   * A tree with 2 levels only has leaves (`numLeaves`) as nodes. If the dataset
   * has more than 100 million rows, then you can use a tree with 3 levels and
   * add branches (`numBranches`) to further partition the dataset.
   */
  treeDepth?: number;

  /**
   * The number of leaves (i.e. potential partitions) for the vector data.
   * Defaults to 1000.
   *
   * You can designate `numLeaves` for trees with 2 or 3 levels. We recommend
   * that the number of leaves is number_of_rows_in_dataset/1000.
   */
  numLeaves?: number;

  /**
   * Optional. The number of branches to further partition the vector data.
   *
   * You can only designate `numBranches` for trees with 3 levels. The number of
   * branches must be fewer than the number of leaves. We recommend that the
   * number of leaves is between 1000 and sqrt(number_of_rows_in_dataset).
   */
  numBranches?: number;
}

/**
 * Settings for Spanner Vector Store.
 *
 * This is used for vector similarity search in a Spanner vector store table.
 * Provide the vector store table and the embedding model settings to use with
 * the `vector_store_similarity_search` tool.
 */
export interface SpannerVectorStoreSettings {
  /** Required. The GCP project id in which the Spanner database resides. */
  projectId: string;

  /** Required. The instance id of the Spanner database. */
  instanceId: string;

  /** Required. The database id of the Spanner database. */
  databaseId: string;

  /**
   * Required. The name of the vector store table to use for vector similarity
   * search.
   */
  tableName: string;

  /**
   * Required. The name of the content column in the vector store table. By
   * default, this column value is also returned as part of the vector
   * similarity search result.
   */
  contentColumn: string;

  /**
   * Required. The name of the embedding column to search in the vector store
   * table.
   */
  embeddingColumn: string;

  /** Required. The dimension of the vectors in the `embeddingColumn`. */
  vectorLength: number;

  /**
   * Required. The Vertex AI embedding model name, which is used to generate
   * embeddings for vector store and vector similarity search.
   *
   * For example, 'text-embedding-005'.
   *
   * Note: the output dimensionality of the embedding model should be the same
   * as the value specified in the `vectorLength` field. Otherwise, a runtime
   * error might be raised during a query.
   */
  vertexAiEmbeddingModelName: string;

  /**
   * The vector store table columns to return in the vector similarity search
   * result. Defaults to `[contentColumn]`.
   *
   * By default, only the `contentColumn` value and the distance value are
   * returned. If specified, the list of selected columns and the distance value
   * are returned. For example, if `selectedColumns` is ['col1', 'col2'], then
   * the result will contain the values of 'col1' and 'col2' columns and the
   * distance value.
   */
  selectedColumns?: string[];

  /**
   * The algorithm used to perform vector similarity search. Defaults to
   * {@link EXACT_NEAREST_NEIGHBORS}.
   *
   * For more details about EXACT_NEAREST_NEIGHBORS, see
   * https://docs.cloud.google.com/spanner/docs/find-k-nearest-neighbors
   * For more details about APPROXIMATE_NEAREST_NEIGHBORS, see
   * https://docs.cloud.google.com/spanner/docs/find-approximate-nearest-neighbors
   */
  nearestNeighborsAlgorithm?: NearestNeighborsAlgorithm;

  /**
   * The number of neighbors to return for each vector similarity search query.
   * The default value is 4.
   */
  topK?: number;

  /**
   * The distance metric used to build the vector index or perform vector
   * similarity search. This value can be COSINE, DOT_PRODUCT, or EUCLIDEAN.
   * Defaults to COSINE.
   */
  distanceType?: string;

  /**
   * Optional. This option specifies how many leaf nodes of the index are
   * searched.
   *
   * Note: This option is only used when the nearest neighbors search algorithm
   * (`nearestNeighborsAlgorithm`) is APPROXIMATE_NEAREST_NEIGHBORS. For more
   * details, see
   * https://docs.cloud.google.com/spanner/docs/vector-index-best-practices
   */
  numLeavesToSearch?: number;

  /**
   * Optional. An optional filter to apply to the search query. If provided,
   * this will be added to the WHERE clause of the final query.
   */
  additionalFilter?: string;

  /**
   * Optional. Settings for the index for use with Approximate Nearest Neighbor
   * (ANN) in the vector store.
   *
   * Note: This option is only required when the nearest neighbors search
   * algorithm (`nearestNeighborsAlgorithm`) is APPROXIMATE_NEAREST_NEIGHBORS.
   * For more details, see
   * https://docs.cloud.google.com/spanner/docs/vector-indexes
   */
  vectorSearchIndexSettings?: VectorSearchIndexSettings;

  /**
   * Optional. A list of supplemental columns to be created when initializing a
   * new vector store table or inserting content rows.
   *
   * Note: This configuration is only utilized during the initial table setup or
   * when inserting content rows.
   */
  additionalColumnsToSetup?: TableColumn[];

  /**
   * Optional. Specifies the column names to be used as the primary key for a
   * new vector store table.
   *
   * If provided, every column name listed here must be defined within
   * `additionalColumnsToSetup`. If this field is omitted, defaults to a single
   * primary key column named `id` which automatically generates UUIDs for each
   * entry.
   *
   * Note: This field is only used during the creation phase of a new vector
   * store.
   */
  primaryKeyColumns?: string[];
}

/** Settings for Spanner tools. */
export interface SpannerToolSettings {
  /**
   * Allowed capabilities for the Spanner tools. Defaults to
   * `[Capabilities.DATA_READ]`.
   *
   * By default, only read operations are allowed. This behaviour may change in
   * future versions. A Spanner admin toolset does not consult this field;
   * constructing it exposes its instance and database creation tools whatever
   * is set here.
   */
  capabilities?: Capabilities[];

  /**
   * Maximum number of rows to return from a query result. Defaults to 50.
   */
  maxExecutedQueryResultRows?: number;

  /**
   * Mode for Spanner execute sql query result. Defaults to
   * {@link QueryResultMode.DEFAULT}.
   */
  queryResultMode?: QueryResultMode;

  /** Optional. The database role to use for the Spanner session. */
  databaseRole?: string;

  /** Settings for Spanner vector store and vector similarity search. */
  vectorStoreSettings?: SpannerVectorStoreSettings;
}

/** Vector store fields that must carry a non-empty value at runtime. */
const REQUIRED_VECTOR_STORE_FIELDS = [
  'projectId',
  'instanceId',
  'databaseId',
  'tableName',
  'contentColumn',
  'embeddingColumn',
  'vertexAiEmbeddingModelName',
] as const satisfies ReadonlyArray<keyof SpannerVectorStoreSettings>;

/**
 * Creates {@link VectorSearchIndexSettings} with the adk-python defaults.
 *
 * Default values applied when the corresponding field is absent from `params`:
 * - `treeDepth` → `2`
 * - `numLeaves` → `1000`
 *
 * @param params - The vector search index settings.
 * @returns The settings with defaults applied.
 */
export function createVectorSearchIndexSettings(
  params: VectorSearchIndexSettings,
) {
  return {
    treeDepth: 2,
    numLeaves: 1000,
    ...params,
  };
}

/**
 * Creates {@link SpannerVectorStoreSettings} with the adk-python defaults and
 * validation.
 *
 * Default values applied when the corresponding field is absent from `params`:
 * - `selectedColumns` → `[params.contentColumn]`
 * - `nearestNeighborsAlgorithm` → {@link EXACT_NEAREST_NEIGHBORS}
 * - `topK` → `4`
 * - `distanceType` → `'COSINE'`
 * - `isNullable` on each `additionalColumnsToSetup` entry → `true`
 *
 * A nested `vectorSearchIndexSettings` is routed through
 * {@link createVectorSearchIndexSettings}, so its defaults apply too.
 *
 * @param params - The vector store settings.
 * @returns The settings with defaults applied.
 * @throws {Error} When a required field holds an empty string.
 * @throws {Error} When `vectorLength` is not a finite number above zero.
 * @throws {Error} When a `primaryKeyColumns` entry names no known column.
 */
export function createSpannerVectorStoreSettings(
  params: SpannerVectorStoreSettings,
) {
  validateRequiredFields(params);
  validateVectorLength(params.vectorLength);
  validatePrimaryKeyColumns(params);
  return {
    nearestNeighborsAlgorithm: EXACT_NEAREST_NEIGHBORS,
    topK: 4,
    distanceType: 'COSINE',
    ...params,
    selectedColumns: params.selectedColumns?.length
      ? params.selectedColumns
      : [params.contentColumn],
    vectorSearchIndexSettings: params.vectorSearchIndexSettings
      ? createVectorSearchIndexSettings(params.vectorSearchIndexSettings)
      : undefined,
    additionalColumnsToSetup: params.additionalColumnsToSetup?.map(
      applyTableColumnDefaults,
    ),
  };
}

/**
 * Creates {@link SpannerToolSettings} with the adk-python defaults.
 *
 * Default values applied when the corresponding field is absent from `params`:
 * - `capabilities` → `[Capabilities.DATA_READ]`
 * - `maxExecutedQueryResultRows` → `50`
 * - `queryResultMode` → {@link QueryResultMode.DEFAULT}
 *
 * A nested `vectorStoreSettings` is routed through
 * {@link createSpannerVectorStoreSettings}, so its defaults and its validation
 * apply too.
 *
 * @param params - Optional partial {@link SpannerToolSettings}.
 * @returns The settings with defaults applied.
 * @throws {Error} When the `SPANNER_TOOL_SETTINGS` feature is disabled.
 * @throws {Error} When a nested `vectorStoreSettings` fails validation.
 */
export function createSpannerToolSettings(params: SpannerToolSettings = {}) {
  if (!isFeatureEnabled(FeatureName.SPANNER_TOOL_SETTINGS)) {
    throw new Error(
      `Feature ${FeatureName.SPANNER_TOOL_SETTINGS} is not enabled.`,
    );
  }
  return {
    capabilities: [Capabilities.DATA_READ],
    maxExecutedQueryResultRows: 50,
    queryResultMode: QueryResultMode.DEFAULT,
    ...params,
    vectorStoreSettings: params.vectorStoreSettings
      ? createSpannerVectorStoreSettings(params.vectorStoreSettings)
      : undefined,
  };
}

function applyTableColumnDefaults(column: TableColumn) {
  return {...column, isNullable: column.isNullable ?? true};
}

function validateRequiredFields(params: SpannerVectorStoreSettings): void {
  for (const field of REQUIRED_VECTOR_STORE_FIELDS) {
    if (!params[field]) {
      throw new Error(
        `Missing required field '${field}' in the Spanner vector store settings.`,
      );
    }
  }
}

function validateVectorLength(vectorLength: number): void {
  if (!Number.isFinite(vectorLength) || vectorLength <= 0) {
    throw new Error(
      'Invalid vector length in the Spanner vector store settings.',
    );
  }
}

function validatePrimaryKeyColumns(params: SpannerVectorStoreSettings): void {
  const columnNames = new Set([params.contentColumn, params.embeddingColumn]);
  for (const column of params.additionalColumnsToSetup ?? []) {
    columnNames.add(column.name);
  }
  for (const primaryKeyColumn of params.primaryKeyColumns ?? []) {
    if (!columnNames.has(primaryKeyColumn)) {
      throw new Error(
        `Primary key column '${primaryKeyColumn}' not found in column definitions.`,
      );
    }
  }
}
