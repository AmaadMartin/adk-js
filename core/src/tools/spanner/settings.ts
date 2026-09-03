/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Vector similarity search using an exhaustive (kNN) scan. */
export const EXACT_NEAREST_NEIGHBORS = 'EXACT_NEAREST_NEIGHBORS';

/** Vector similarity search using a vector index (ANN). */
export const APPROXIMATE_NEAREST_NEIGHBORS = 'APPROXIMATE_NEAREST_NEIGHBORS';

/** The nearest neighbors search algorithms Spanner supports. */
export type NearestNeighborsAlgorithm =
  | typeof EXACT_NEAREST_NEIGHBORS
  | typeof APPROXIMATE_NEAREST_NEIGHBORS;

/** The kind of operation the Spanner tools are allowed to perform. */
export enum Capabilities {
  /** Read-only data operations are allowed. */
  DATA_READ = 'data_read',
}

/** The shape of the rows `execute_sql` returns. */
export enum QueryResultMode {
  /** Each row is the list of its column values. */
  DEFAULT = 'default',
  /** Each row is an object keyed by column name. */
  DICT_LIST = 'dict_list',
}

/** The row cap `execute_sql` falls back to. */
export const DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS = 50;

/** Constructor options for {@link SpannerVectorStoreSettings}. */
export interface SpannerVectorStoreSettingsOptions {
  /** The Google Cloud project id the Spanner database lives in. */
  projectId: string;
  /** The instance id of the Spanner database. */
  instanceId: string;
  /** The database id of the Spanner database. */
  databaseId: string;
  /** The name of the vector store table. */
  tableName: string;
  /** The name of the content column in the vector store table. */
  contentColumn: string;
  /** The name of the embedding column to search. */
  embeddingColumn: string;
  /** The dimension of the vectors held in the embedding column. */
  vectorLength: number;
  /**
   * The Vertex AI embedding model used to embed the search query, for example
   * `text-embedding-005`. Its output dimensionality must match
   * {@link vectorLength}.
   */
  vertexAiEmbeddingModelName: string;
  /**
   * The columns to return alongside the distance. Defaults to just the
   * content column.
   */
  selectedColumns?: string[];
  /** The search algorithm. Defaults to `EXACT_NEAREST_NEIGHBORS`. */
  nearestNeighborsAlgorithm?: NearestNeighborsAlgorithm;
  /** The number of neighbors to return. Defaults to `4`. */
  topK?: number;
  /**
   * The distance metric: `COSINE`, `DOT_PRODUCT` or `EUCLIDEAN`. Defaults to
   * `COSINE`.
   */
  distanceType?: string;
  /** How many leaf nodes of the index an ANN search reads. */
  numLeavesToSearch?: number;
  /** A filter added to the `WHERE` clause of the search query. */
  additionalFilter?: string;
}

/**
 * Settings for a Spanner vector store table, used by the
 * `vector_store_similarity_search` tool.
 */
export class SpannerVectorStoreSettings {
  readonly projectId: string;
  readonly instanceId: string;
  readonly databaseId: string;
  readonly tableName: string;
  readonly contentColumn: string;
  readonly embeddingColumn: string;
  readonly vectorLength: number;
  readonly vertexAiEmbeddingModelName: string;
  readonly selectedColumns: string[];
  readonly nearestNeighborsAlgorithm: NearestNeighborsAlgorithm;
  readonly topK: number;
  readonly distanceType: string;
  readonly numLeavesToSearch?: number;
  readonly additionalFilter?: string;

  constructor(options: SpannerVectorStoreSettingsOptions) {
    if (!options.vectorLength || options.vectorLength <= 0) {
      throw new Error(
        'Invalid vector length in the Spanner vector store settings.',
      );
    }

    this.projectId = options.projectId;
    this.instanceId = options.instanceId;
    this.databaseId = options.databaseId;
    this.tableName = options.tableName;
    this.contentColumn = options.contentColumn;
    this.embeddingColumn = options.embeddingColumn;
    this.vectorLength = options.vectorLength;
    this.vertexAiEmbeddingModelName = options.vertexAiEmbeddingModelName;
    this.selectedColumns = options.selectedColumns?.length
      ? options.selectedColumns
      : [options.contentColumn];
    this.nearestNeighborsAlgorithm =
      options.nearestNeighborsAlgorithm ?? EXACT_NEAREST_NEIGHBORS;
    this.topK = options.topK ?? 4;
    this.distanceType = options.distanceType ?? 'COSINE';
    this.numLeavesToSearch = options.numLeavesToSearch;
    this.additionalFilter = options.additionalFilter;
  }
}

/** Constructor options for {@link SpannerToolSettings}. */
export interface SpannerToolSettingsOptions {
  /**
   * The operations the tools may perform. Defaults to
   * `[Capabilities.DATA_READ]`, so the data-reading tools are exposed. Pass
   * an empty array to expose only the metadata tools.
   */
  capabilities?: Capabilities[];
  /** The maximum number of rows `execute_sql` returns. Defaults to `50`. */
  maxExecutedQueryResultRows?: number;
  /** The shape of the rows `execute_sql` returns. Defaults to `DEFAULT`. */
  queryResultMode?: QueryResultMode;
  /** The database role the Spanner session runs as. */
  databaseRole?: string;
  /** The vector store the `vector_store_similarity_search` tool searches. */
  vectorStoreSettings?: SpannerVectorStoreSettings;
}

/** Settings for the Spanner tools. */
export class SpannerToolSettings {
  readonly capabilities: Capabilities[];
  readonly maxExecutedQueryResultRows: number;
  readonly queryResultMode: QueryResultMode;
  readonly databaseRole?: string;
  readonly vectorStoreSettings?: SpannerVectorStoreSettings;

  constructor(options: SpannerToolSettingsOptions = {}) {
    this.capabilities = options.capabilities ?? [Capabilities.DATA_READ];
    this.maxExecutedQueryResultRows =
      options.maxExecutedQueryResultRows ??
      DEFAULT_MAX_EXECUTED_QUERY_RESULT_ROWS;
    this.queryResultMode = options.queryResultMode ?? QueryResultMode.DEFAULT;
    this.databaseRole = options.databaseRole;
    this.vectorStoreSettings = options.vectorStoreSettings;
  }
}
