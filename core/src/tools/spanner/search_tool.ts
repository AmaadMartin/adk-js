/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Database} from '@google-cloud/spanner';
import {GoogleGenAI} from '@google/genai';
import type {AuthClient} from 'google-auth-library';
import {z} from 'zod';
import {geminiInitParams} from '../../models/google_llm.js';
import {
  databaseParameters,
  GOOGLE_STANDARD_SQL_DIALECT,
  POSTGRESQL_DIALECT,
  withSpannerDatabase,
} from './client.js';
import {rowValues, toSerializable} from './result_rows.js';
import {
  generateSqlForAnn,
  generateSqlForKnn,
  GOOGLESQL_EMBEDDING_PARAMETER,
  GOOGLESQL_TEXT_QUERY_PARAMETER,
  POSTGRESQL_EMBEDDING_PARAMETER,
  POSTGRESQL_TEXT_QUERY_PARAMETER,
  ResolvedSearchOptions,
  SearchQuery,
} from './search_sql.js';
import {
  APPROXIMATE_NEAREST_NEIGHBORS,
  EXACT_NEAREST_NEIGHBORS,
  SpannerToolSettings,
} from './settings.js';
import {
  SpannerTool,
  SpannerToolFactoryOptions,
  SpannerToolResult,
  SpannerToolStatus,
  toErrorDetails,
} from './spanner_tool.js';
import {
  validateAdditionalFilter,
  validateColumnList,
  validateIdentifier,
  validateVertexAiEndpoint,
} from './sql_validation.js';

/** Embed the query with a public Vertex AI model, in either dialect. */
const VERTEX_AI_EMBEDDING_MODEL_NAME = 'vertex_ai_embedding_model_name';
/** Embed the query with a model registered in a GoogleSQL database. */
const SPANNER_GSQL_EMBEDDING_MODEL_NAME =
  'spanner_googlesql_embedding_model_name';
/** Embed the query with a Vertex AI endpoint, from a PostgreSQL database. */
const SPANNER_PG_VERTEX_AI_EMBEDDING_MODEL_ENDPOINT =
  'spanner_postgresql_vertex_ai_embedding_model_endpoint';
const OUTPUT_DIMENSIONALITY = 'output_dimensionality';

const TOP_K = 'top_k';
const DISTANCE_TYPE = 'distance_type';
const NEAREST_NEIGHBORS_ALGORITHM = 'nearest_neighbors_algorithm';
const NUM_LEAVES_TO_SEARCH = 'num_leaves_to_search';

const DEFAULT_DISTANCE_TYPE = 'COSINE';
const DEFAULT_TOP_K = 4;
const DEFAULT_NUM_LEAVES_TO_SEARCH = 1000;

/** Reads an option that must be a string. */
function optionalString(
  options: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = options[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Option '${key}' must be a string, got ${String(value)}.`);
  }
  return value;
}

/**
 * Reads an option that must be a whole number, accepting the numeric strings
 * a model tends to emit.
 */
function optionalInteger(
  options: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = options[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed)) {
    throw new Error(
      `Option '${key}' must be an integer, got ${String(value)}.`,
    );
  }
  return parsed;
}

/** The embedding query for a model registered in a GoogleSQL database. */
function googlesqlEmbeddingQuery(modelName: string): string {
  return `
    SELECT embeddings.values
    FROM ML.PREDICT(
      MODEL ${modelName},
      (SELECT CAST(@${GOOGLESQL_TEXT_QUERY_PARAMETER} AS STRING) as content)
    )
  `;
}

/** The embedding query for a Vertex AI endpoint, in a PostgreSQL database. */
function postgresqlEmbeddingQuery(
  endpoint: string,
  outputDimensionality?: number,
): string {
  const parameters =
    outputDimensionality === undefined
      ? ''
      : `,
      'parameters',
      JSONB_BUILD_OBJECT('outputDimensionality', ${outputDimensionality})`;
  return `
    SELECT spanner.FLOAT32_ARRAY(
      spanner.ML_PREDICT_ROW(
        '${endpoint}',
        JSONB_BUILD_OBJECT(
          'instances',
          JSONB_BUILD_ARRAY(
            JSONB_BUILD_OBJECT(
              'content',
              $${POSTGRESQL_TEXT_QUERY_PARAMETER}::TEXT
            )
          )${parameters}
        )
      ) -> 'predictions' -> 0 -> 'embeddings' -> 'values'
    )
  `;
}

/** How the query is embedded, once the options have been resolved. */
type EmbeddingSource =
  | {kind: 'vertexAi'; model: string}
  | {kind: 'googlesql'; model: string}
  | {kind: 'postgresql'; endpoint: string};

/** The embedding model options a caller supplied. */
interface EmbeddingModels {
  vertexAi?: string;
  googlesqlModelName?: string;
  postgresqlEndpoint?: string;
}

/**
 * Chooses how to embed the query, rejecting a model the database's dialect
 * cannot use.
 *
 * @param dialect The dialect of the target database.
 * @param models The embedding model options the caller supplied.
 * @throws If no supplied model works with the dialect.
 */
function embeddingSource(
  dialect: string,
  models: EmbeddingModels,
): EmbeddingSource {
  if (models.vertexAi) {
    return {kind: 'vertexAi', model: models.vertexAi};
  }
  if (dialect === POSTGRESQL_DIALECT) {
    if (models.postgresqlEndpoint) {
      return {kind: 'postgresql', endpoint: models.postgresqlEndpoint};
    }
    throw new Error(
      `embedding_options['${VERTEX_AI_EMBEDDING_MODEL_NAME}'] or` +
        ` embedding_options['${SPANNER_PG_VERTEX_AI_EMBEDDING_MODEL_ENDPOINT}']` +
        ' must be specified for PostgreSQL dialect Spanner database.',
    );
  }
  if (models.googlesqlModelName) {
    return {kind: 'googlesql', model: models.googlesqlModelName};
  }
  throw new Error(
    `embedding_options['${VERTEX_AI_EMBEDDING_MODEL_NAME}'] or` +
      ` embedding_options['${SPANNER_GSQL_EMBEDDING_MODEL_NAME}'] must be` +
      ' specified for GoogleSQL dialect Spanner database.',
  );
}

/** Embeds the query inside Spanner, using the database's own model. */
async function embedQueryInSpanner(
  database: Database,
  source: Exclude<EmbeddingSource, {kind: 'vertexAi'}>,
  query: string,
  outputDimensionality?: number,
): Promise<unknown> {
  const statement =
    source.kind === 'postgresql'
      ? {
          sql: postgresqlEmbeddingQuery(source.endpoint, outputDimensionality),
          params: {[`p${POSTGRESQL_TEXT_QUERY_PARAMETER}`]: query},
        }
      : {
          sql: googlesqlEmbeddingQuery(source.model),
          params: {[GOOGLESQL_TEXT_QUERY_PARAMETER]: query},
        };
  const [rows] = await database.run(statement);
  const first = rows[0];
  if (!first) {
    throw new Error('The embedding query returned no rows.');
  }
  return rowValues(first)[0];
}

/** Builds the GenAI client the Vertex AI embedding path calls. */
function embeddingClient(model: string): GoogleGenAI {
  const params = geminiInitParams({model});
  return params.vertexai
    ? new GoogleGenAI({
        vertexai: true,
        project: params.project,
        location: params.location,
      })
    : new GoogleGenAI({apiKey: params.apiKey});
}

/** Embeds the query with a public Vertex AI embedding model. */
async function embedQueryWithVertexAi(
  model: string,
  query: string,
  outputDimensionality?: number,
): Promise<number[]> {
  try {
    const response = await embeddingClient(model).models.embedContent({
      model,
      contents: [query],
      config: outputDimensionality ? {outputDimensionality} : {},
    });
    const values = response.embeddings?.[0]?.values;
    if (!values) {
      throw new Error('the response carried no embedding.');
    }
    return values;
  } catch (err: unknown) {
    throw new Error(`Failed to embed content: ${toErrorDetails(err)}`);
  }
}

/** Reads and defaults the search options a caller supplied. */
function resolveSearchOptions(
  options: Record<string, unknown>,
): ResolvedSearchOptions {
  const algorithm =
    optionalString(options, NEAREST_NEIGHBORS_ALGORITHM) ??
    EXACT_NEAREST_NEIGHBORS;
  if (
    algorithm !== EXACT_NEAREST_NEIGHBORS &&
    algorithm !== APPROXIMATE_NEAREST_NEIGHBORS
  ) {
    throw new Error(
      `Unsupported search_options['${NEAREST_NEIGHBORS_ALGORITHM}']: ${algorithm}`,
    );
  }
  return {
    distanceType:
      optionalString(options, DISTANCE_TYPE) ?? DEFAULT_DISTANCE_TYPE,
    topK: optionalInteger(options, TOP_K) ?? DEFAULT_TOP_K,
    algorithm,
    numLeavesToSearch:
      optionalInteger(options, NUM_LEAVES_TO_SEARCH) ??
      DEFAULT_NUM_LEAVES_TO_SEARCH,
  };
}

/** Everything a vector search needs, from either of the two entry points. */
interface SimilaritySearchRequest {
  projectId: string;
  instanceId: string;
  databaseId: string;
  tableName: string;
  query: string;
  embeddingColumnToSearch: string;
  columns: string[];
  embeddingOptions: Record<string, unknown>;
  additionalFilter?: string;
  searchOptions: Record<string, unknown>;
  credentials?: AuthClient;
}

/** Checks that exactly one of the three embedding model options is present. */
function assertOneEmbeddingModel(options: Record<string, unknown>): void {
  const present = [
    VERTEX_AI_EMBEDDING_MODEL_NAME,
    SPANNER_GSQL_EMBEDDING_MODEL_NAME,
    SPANNER_PG_VERTEX_AI_EMBEDDING_MODEL_ENDPOINT,
  ].filter((key) => key in options);
  if (present.length !== 1) {
    throw new Error('Exactly one embedding model option must be specified.');
  }
}

/** Runs a vector similarity search against an open Spanner database. */
async function searchDatabase(
  database: Database,
  request: SimilaritySearchRequest,
): Promise<SpannerToolResult> {
  const dialect = await database.getDatabaseDialect();
  if (
    dialect !== GOOGLE_STANDARD_SQL_DIALECT &&
    dialect !== POSTGRESQL_DIALECT
  ) {
    throw new Error(`Unsupported database dialect: ${dialect}`);
  }

  assertOneEmbeddingModel(request.embeddingOptions);
  const models: EmbeddingModels = {
    vertexAi: optionalString(
      request.embeddingOptions,
      VERTEX_AI_EMBEDDING_MODEL_NAME,
    ),
    googlesqlModelName: optionalString(
      request.embeddingOptions,
      SPANNER_GSQL_EMBEDDING_MODEL_NAME,
    ),
    postgresqlEndpoint: optionalString(
      request.embeddingOptions,
      SPANNER_PG_VERTEX_AI_EMBEDDING_MODEL_ENDPOINT,
    ),
  };
  const source = embeddingSource(dialect, models);

  const outputDimensionality = optionalInteger(
    request.embeddingOptions,
    OUTPUT_DIMENSIONALITY,
  );
  if (outputDimensionality !== undefined && source.kind === 'googlesql') {
    throw new Error(
      `embedding_options[${OUTPUT_DIMENSIONALITY}] is not supported when` +
        ` embedding_options['${SPANNER_GSQL_EMBEDDING_MODEL_NAME}'] is` +
        ' specified.',
    );
  }

  const options = resolveSearchOptions(request.searchOptions);
  const embedding =
    source.kind === 'vertexAi'
      ? await embedQueryWithVertexAi(
          source.model,
          request.query,
          outputDimensionality,
        )
      : await embedQueryInSpanner(
          database,
          source,
          request.query,
          outputDimensionality,
        );

  const searchQuery: SearchQuery = {
    tableName: request.tableName,
    embeddingColumn: request.embeddingColumnToSearch,
    columns: request.columns,
    additionalFilter: request.additionalFilter,
  };
  const sql =
    options.algorithm === EXACT_NEAREST_NEIGHBORS
      ? generateSqlForKnn(dialect, searchQuery, options)
      : generateSqlForAnn(dialect, searchQuery, options);
  const params =
    dialect === POSTGRESQL_DIALECT
      ? {[`p${POSTGRESQL_EMBEDDING_PARAMETER}`]: embedding}
      : {[GOOGLESQL_EMBEDDING_PARAMETER]: embedding};

  const [rows] = await database.run({sql, params});
  return {
    status: SpannerToolStatus.SUCCESS,
    rows: rows.map((row) => toSerializable(rowValues(row))),
  };
}

/** Opens the target database and runs the search against it. */
function similaritySearch(
  request: SimilaritySearchRequest,
): Promise<SpannerToolResult> {
  return withSpannerDatabase(
    {
      projectId: request.projectId,
      instanceId: request.instanceId,
      databaseId: request.databaseId,
      credentials: request.credentials,
    },
    (database) => searchDatabase(database, request),
  );
}

const similaritySearchParameters = z.object({
  ...databaseParameters,
  table_name: z.string().describe('The table to search.'),
  query: z
    .string()
    .describe('The text to embed and find the most similar rows for.'),
  embedding_column_to_search: z
    .string()
    .describe('The column holding the embeddings to search.'),
  columns: z
    .array(z.string())
    .describe('The columns to return alongside the distance.'),
  embedding_options: z
    .record(z.string(), z.string())
    .describe(
      'How to embed the query. Exactly one of ' +
        `'${VERTEX_AI_EMBEDDING_MODEL_NAME}' (a public Vertex AI model, either ` +
        `dialect), '${SPANNER_GSQL_EMBEDDING_MODEL_NAME}' (a model registered ` +
        `in a GoogleSQL database) or ` +
        `'${SPANNER_PG_VERTEX_AI_EMBEDDING_MODEL_ENDPOINT}' (a Vertex AI ` +
        `endpoint, PostgreSQL only) must be set. '${OUTPUT_DIMENSIONALITY}' ` +
        'optionally sets the embedding size.',
    ),
  additional_filter: z
    .string()
    .optional()
    .describe(
      'A filter added to the WHERE clause. Columns and values compared with ' +
        '=, !=, <, >, <=, >=, LIKE, IS, IS NOT, IN, NOT IN or BETWEEN, ' +
        'joined by AND or OR, with up to 2 levels of parentheses. Values ' +
        'must be numbers, single-quoted strings without backslashes, ' +
        'booleans or NULL.',
    ),
  search_options: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      `How to search: '${TOP_K}' (default ${DEFAULT_TOP_K}), ` +
        `'${DISTANCE_TYPE}' (COSINE, EUCLIDEAN or DOT_PRODUCT, default ` +
        `${DEFAULT_DISTANCE_TYPE}), '${NEAREST_NEIGHBORS_ALGORITHM}' ` +
        `(${EXACT_NEAREST_NEIGHBORS} or ${APPROXIMATE_NEAREST_NEIGHBORS}, ` +
        `default ${EXACT_NEAREST_NEIGHBORS}) and '${NUM_LEAVES_TO_SEARCH}' ` +
        '(approximate search only).',
    ),
});

/**
 * Builds the `similarity_search` tool, which embeds a text query and returns
 * the closest rows of a table.
 *
 * Every identifier and the filter reach the generated SQL by concatenation,
 * so they are checked against an allow-list before the search runs.
 */
export function createSimilaritySearchTool(
  options: SpannerToolFactoryOptions,
): SpannerTool {
  return SpannerTool.create({
    ...options,
    name: 'similarity_search',
    description:
      'Find the rows of a Spanner table whose embeddings are closest to a ' +
      'text query. The last column of each row is the distance.',
    parameters: similaritySearchParameters,
    execute: ({args, credentials}) => {
      validateIdentifier(args.table_name, 'table_name');
      validateIdentifier(
        args.embedding_column_to_search,
        'embedding_column_to_search',
      );
      validateColumnList(args.columns, 'columns');
      if (args.additional_filter) {
        validateAdditionalFilter(args.additional_filter);
      }
      const embeddingOptions = args.embedding_options;
      const googlesqlModel =
        embeddingOptions[SPANNER_GSQL_EMBEDDING_MODEL_NAME];
      if (googlesqlModel) {
        validateIdentifier(googlesqlModel, SPANNER_GSQL_EMBEDDING_MODEL_NAME);
      }
      const postgresqlEndpoint =
        embeddingOptions[SPANNER_PG_VERTEX_AI_EMBEDDING_MODEL_ENDPOINT];
      if (postgresqlEndpoint) {
        validateVertexAiEndpoint(postgresqlEndpoint);
      }
      return similaritySearch({
        projectId: args.project_id,
        instanceId: args.instance_id,
        databaseId: args.database_id,
        tableName: args.table_name,
        query: args.query,
        embeddingColumnToSearch: args.embedding_column_to_search,
        columns: args.columns,
        embeddingOptions,
        additionalFilter: args.additional_filter,
        searchOptions: args.search_options ?? {},
        credentials,
      });
    },
  });
}

const vectorStoreSimilaritySearchParameters = z.object({
  query: z
    .string()
    .describe('The search text, based on the user\u2019s question.'),
});

/** Maps the configured vector store onto a similarity search request. */
function vectorStoreRequest(
  query: string,
  settings: SpannerToolSettings,
  credentials?: AuthClient,
): SimilaritySearchRequest {
  const store = settings.vectorStoreSettings;
  if (!store) {
    throw new Error('Spanner vector store settings are not set.');
  }
  const searchOptions: Record<string, unknown> = {
    [TOP_K]: store.topK,
    [DISTANCE_TYPE]: store.distanceType,
    [NEAREST_NEIGHBORS_ALGORITHM]: store.nearestNeighborsAlgorithm,
  };
  if (store.nearestNeighborsAlgorithm === APPROXIMATE_NEAREST_NEIGHBORS) {
    searchOptions[NUM_LEAVES_TO_SEARCH] = store.numLeavesToSearch;
  }
  return {
    projectId: store.projectId,
    instanceId: store.instanceId,
    databaseId: store.databaseId,
    tableName: store.tableName,
    query,
    embeddingColumnToSearch: store.embeddingColumn,
    columns: store.selectedColumns,
    embeddingOptions: {
      [VERTEX_AI_EMBEDDING_MODEL_NAME]: store.vertexAiEmbeddingModelName,
      [OUTPUT_DIMENSIONALITY]: store.vectorLength,
    },
    additionalFilter: store.additionalFilter,
    searchOptions,
    credentials,
  };
}

/**
 * Builds the `vector_store_similarity_search` tool, which searches the vector
 * store the toolset was configured with.
 */
export function createVectorStoreSimilaritySearchTool(
  options: SpannerToolFactoryOptions,
): SpannerTool {
  return SpannerTool.create({
    ...options,
    name: 'vector_store_similarity_search',
    description:
      'Retrieve the context most relevant to a question from the configured ' +
      'Spanner vector store. The last column of each row is the distance.',
    parameters: vectorStoreSimilaritySearchParameters,
    execute: ({args, credentials, settings}) =>
      similaritySearch(vectorStoreRequest(args.query, settings, credentials)),
  });
}
