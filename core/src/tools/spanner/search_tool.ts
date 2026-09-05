/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Database} from '@google-cloud/spanner';
import {z} from 'zod';
import {SpannerDatabaseDialect, withSnapshot} from './client.js';
import {embedContent} from './embedding.js';
import {selectValueRows, toJsonSafe} from './result_rows.js';
import {
  APPROXIMATE_NEAREST_NEIGHBORS,
  EXACT_NEAREST_NEIGHBORS,
  resolveVectorStoreSettings,
  SpannerToolSettings,
} from './settings.js';
import {
  POSTGRESQL_DIALECT,
  SpannerToolCall,
  SpannerToolDefinition,
} from './spanner_tool.js';
import {
  validateAdditionalFilter,
  validateColumnList,
  validateIdentifier,
  validateVertexAiEndpoint,
} from './sql_validation.js';

/** Keys the model may set in `embedding_options`. */
const VERTEX_AI_EMBEDDING_MODEL_NAME = 'vertex_ai_embedding_model_name';
const SPANNER_GSQL_EMBEDDING_MODEL_NAME =
  'spanner_googlesql_embedding_model_name';
const SPANNER_PG_VERTEX_AI_EMBEDDING_MODEL_ENDPOINT =
  'spanner_postgresql_vertex_ai_embedding_model_endpoint';
const OUTPUT_DIMENSIONALITY = 'output_dimensionality';

/** Exactly one of these names the model that produces the query vector. */
const EMBEDDING_MODEL_KEYS = [
  VERTEX_AI_EMBEDDING_MODEL_NAME,
  SPANNER_GSQL_EMBEDDING_MODEL_NAME,
  SPANNER_PG_VERTEX_AI_EMBEDDING_MODEL_ENDPOINT,
];

/** Keys the model may set in `search_options`. */
const TOP_K = 'top_k';
const DISTANCE_TYPE = 'distance_type';
const NEAREST_NEIGHBORS_ALGORITHM = 'nearest_neighbors_algorithm';
const NUM_LEAVES_TO_SEARCH = 'num_leaves_to_search';

const DISTANCE_ALIAS = 'distance';
const GOOGLESQL_TEXT_QUERY_PARAMETER = 'query';
const GOOGLESQL_EMBEDDING_PARAMETER = 'embedding';

const DEFAULT_DISTANCE_TYPE = 'COSINE';
const DEFAULT_TOP_K = 4;
const DEFAULT_NUM_LEAVES_TO_SEARCH = 1000;

/** A record of options as a model-generated tool call carries them. */
type ToolOptions = Record<string, unknown>;

/**
 * Reads one option as a string.
 *
 * @throws Error if the option is present and is not a string.
 */
function optionalStringOption(
  options: ToolOptions,
  key: string,
): string | undefined {
  const value = options[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(
      `Option '${key}' must be a string, got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * Reads one option as an integer, accepting the numeric strings a model tends
 * to emit.
 *
 * @throws Error if the option is present and is not a whole number.
 */
function optionalIntOption(
  options: ToolOptions,
  key: string,
): number | undefined {
  const value = options[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed =
    typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)) {
    throw new Error(
      `Option '${key}' must be an integer, got ${JSON.stringify(value)}.`,
    );
  }
  return parsed;
}

/** Which model turns the text query into a vector, and how it is reached. */
type EmbeddingModel =
  | {kind: 'vertexAi'; modelName: string}
  | {kind: 'googlesql'; modelName: string}
  | {kind: 'postgresql'; endpoint: string};

/** Builds the `ML.PREDICT` statement that embeds the query inside Spanner. */
function googlesqlEmbeddingQuery(modelName: string): string {
  return `
    SELECT embeddings.values
    FROM ML.PREDICT(
      MODEL ${modelName},
      (SELECT CAST(@${GOOGLESQL_TEXT_QUERY_PARAMETER} AS STRING) as content)
    )
  `;
}

/** Builds the `spanner.ML_PREDICT_ROW` statement for a PostgreSQL database. */
function postgresqlEmbeddingQuery(
  endpoint: string,
  outputDimensionality: number | undefined,
): string {
  const instances = `
      'instances',
      JSONB_BUILD_ARRAY(
          JSONB_BUILD_OBJECT(
              'content',
              $1::TEXT
          )
      )
  `;
  const parameters =
    outputDimensionality === undefined
      ? []
      : [
          `
        'parameters',
        JSONB_BUILD_OBJECT(
            'outputDimensionality',
            ${outputDimensionality}
        )
    `,
        ];
  return `
      SELECT spanner.FLOAT32_ARRAY(
          spanner.ML_PREDICT_ROW(
              '${endpoint}',
              JSONB_BUILD_OBJECT(
                  ${[instances, ...parameters].join(',\n')}
              )
          ) -> 'predictions' -> 0 -> 'embeddings' -> 'values'
      )
  `;
}

/** Asks Spanner itself to embed the query. */
async function embedInSpanner(
  database: Database,
  model: Exclude<EmbeddingModel, {kind: 'vertexAi'}>,
  query: string,
  outputDimensionality: number | undefined,
): Promise<unknown> {
  const request =
    model.kind === 'postgresql'
      ? {
          sql: postgresqlEmbeddingQuery(model.endpoint, outputDimensionality),
          params: {['p1']: query},
        }
      : {
          sql: googlesqlEmbeddingQuery(model.modelName),
          params: {[GOOGLESQL_TEXT_QUERY_PARAMETER]: query},
        };
  const rows = await withSnapshot(database, (snapshot) =>
    selectValueRows(snapshot, request),
  );
  return rows[0]?.[0];
}

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

const GOOGLESQL_APPROX_DISTANCE_FUNCTIONS: Record<string, string> = {
  COSINE: 'APPROX_COSINE_DISTANCE',
  EUCLIDEAN: 'APPROX_EUCLIDEAN_DISTANCE',
  DOT_PRODUCT: 'APPROX_DOT_PRODUCT',
};

/**
 * Reads the distance function for a distance type.
 *
 * @throws Error if the distance type is not one Spanner offers.
 */
function distanceFunction(
  functions: Record<string, string>,
  distanceType: string,
): string {
  const name = functions[distanceType];
  if (!name) {
    throw new Error(`Unsupported distance_type: ${distanceType}`);
  }
  return name;
}

/** What both statement generators need to know about the search. */
interface SearchSql {
  dialect: SpannerDatabaseDialect;
  tableName: string;
  embeddingColumnToSearch: string;
  columns: readonly string[];
  additionalFilter?: string;
  distanceType: string;
  topK: number;
}

/** Builds the exhaustive k-nearest-neighbour statement. */
function generateSqlForKnn(search: SearchSql): string {
  const postgres = search.dialect === POSTGRESQL_DIALECT;
  const fn = postgres
    ? distanceFunction(POSTGRESQL_DISTANCE_FUNCTIONS, search.distanceType)
    : distanceFunction(GOOGLESQL_DISTANCE_FUNCTIONS, search.distanceType);
  const embeddingParameter = postgres
    ? '$1'
    : `@${GOOGLESQL_EMBEDDING_PARAMETER}`;
  const columns = [
    ...search.columns,
    `${fn}(
      ${search.embeddingColumnToSearch},
      ${embeddingParameter}) AS ${DISTANCE_ALIAS}
  `,
  ].join(', ');
  const limit = search.topK > 0 ? `LIMIT ${search.topK}` : '';
  return `
    SELECT ${columns}
    FROM ${search.tableName}
    WHERE ${search.additionalFilter || '1=1'}
    ORDER BY ${DISTANCE_ALIAS}
    ${limit}
  `;
}

/**
 * Builds the approximate nearest-neighbour statement, which reads a vector
 * index.
 *
 * @throws Error if the database speaks PostgreSQL, which has no `APPROX_*`
 *   distance function.
 */
function generateSqlForAnn(
  search: SearchSql,
  numLeavesToSearch: number,
): string {
  if (search.dialect === POSTGRESQL_DIALECT) {
    throw new Error(
      `${APPROXIMATE_NEAREST_NEIGHBORS} is not supported for PostgreSQL` +
        ' dialect.',
    );
  }
  const fn = distanceFunction(
    GOOGLESQL_APPROX_DISTANCE_FUNCTIONS,
    search.distanceType,
  );
  const columns = [
    ...search.columns,
    `${fn}(
      ${search.embeddingColumnToSearch},
      @${GOOGLESQL_EMBEDDING_PARAMETER},
      options => JSON '{"num_leaves_to_search": ${numLeavesToSearch}}'
  ) AS ${DISTANCE_ALIAS}
  `,
  ].join(', ');
  const notNull = `${search.embeddingColumnToSearch} IS NOT NULL`;
  const filter = search.additionalFilter
    ? `${notNull} AND ${search.additionalFilter}`
    : notNull;
  return `
    SELECT ${columns}
    FROM ${search.tableName}
    WHERE ${filter}
    ORDER BY ${DISTANCE_ALIAS}
    LIMIT ${search.topK}
  `;
}

/** Everything one similarity search needs, however it was requested. */
interface SimilaritySearchRequest {
  tableName: string;
  query: string;
  embeddingColumnToSearch: string;
  columns: readonly string[];
  embeddingOptions: ToolOptions;
  additionalFilter?: string;
  searchOptions: ToolOptions;
}

/**
 * Chooses the embedding model the options name.
 *
 * @throws Error if the options do not name exactly one model, if the model
 *   they name cannot serve this dialect, or if an output dimensionality is
 *   combined with a Spanner GoogleSQL model.
 */
function selectEmbeddingModel(
  dialect: SpannerDatabaseDialect,
  options: ToolOptions,
  outputDimensionality: number | undefined,
): EmbeddingModel {
  const named = Object.keys(options).filter((key) =>
    EMBEDDING_MODEL_KEYS.includes(key),
  );
  if (named.length !== 1) {
    throw new Error('Exactly one embedding model option must be specified.');
  }

  const vertexAi = optionalStringOption(
    options,
    VERTEX_AI_EMBEDDING_MODEL_NAME,
  );
  const googlesql = optionalStringOption(
    options,
    SPANNER_GSQL_EMBEDDING_MODEL_NAME,
  );
  const postgresql = optionalStringOption(
    options,
    SPANNER_PG_VERTEX_AI_EMBEDDING_MODEL_ENDPOINT,
  );

  if (outputDimensionality !== undefined && googlesql !== undefined) {
    // Spanner's ML.PREDICT does not take an output dimensionality.
    throw new Error(
      `embedding_options[${OUTPUT_DIMENSIONALITY}] is not supported when` +
        ` embedding_options['${SPANNER_GSQL_EMBEDDING_MODEL_NAME}'] is` +
        ' specified.',
    );
  }

  if (vertexAi !== undefined) {
    return {kind: 'vertexAi', modelName: vertexAi};
  }
  if (dialect === POSTGRESQL_DIALECT) {
    if (postgresql === undefined) {
      throw new Error(
        `embedding_options['${VERTEX_AI_EMBEDDING_MODEL_NAME}'] or` +
          ` embedding_options['${SPANNER_PG_VERTEX_AI_EMBEDDING_MODEL_ENDPOINT}']` +
          ' must be specified for PostgreSQL dialect Spanner database.',
      );
    }
    return {kind: 'postgresql', endpoint: postgresql};
  }
  if (googlesql === undefined) {
    throw new Error(
      `embedding_options['${VERTEX_AI_EMBEDDING_MODEL_NAME}'] or` +
        ` embedding_options['${SPANNER_GSQL_EMBEDDING_MODEL_NAME}'] must be` +
        ' specified for GoogleSQL dialect Spanner database.',
    );
  }
  return {kind: 'googlesql', modelName: googlesql};
}

/**
 * Embeds the query, builds the search statement and runs it.
 *
 * @throws Error if the database speaks a dialect the tools do not know, or if
 *   the options are inconsistent.
 */
async function similaritySearch(
  {database, dialect}: SpannerToolCall,
  request: SimilaritySearchRequest,
): Promise<{rows: unknown[]}> {
  if (dialect !== 'GOOGLE_STANDARD_SQL' && dialect !== POSTGRESQL_DIALECT) {
    throw new Error(`Unsupported database dialect: ${dialect}`);
  }

  const outputDimensionality = optionalIntOption(
    request.embeddingOptions,
    OUTPUT_DIMENSIONALITY,
  );
  const model = selectEmbeddingModel(
    dialect,
    request.embeddingOptions,
    outputDimensionality,
  );

  const algorithm =
    optionalStringOption(request.searchOptions, NEAREST_NEIGHBORS_ALGORITHM) ||
    EXACT_NEAREST_NEIGHBORS;
  if (
    algorithm !== EXACT_NEAREST_NEIGHBORS &&
    algorithm !== APPROXIMATE_NEAREST_NEIGHBORS
  ) {
    throw new Error(
      `Unsupported search_options['${NEAREST_NEIGHBORS_ALGORITHM}']:` +
        ` ${algorithm}`,
    );
  }

  const search: SearchSql = {
    dialect,
    tableName: request.tableName,
    embeddingColumnToSearch: request.embeddingColumnToSearch,
    columns: request.columns,
    additionalFilter: request.additionalFilter,
    distanceType:
      optionalStringOption(request.searchOptions, DISTANCE_TYPE) ||
      DEFAULT_DISTANCE_TYPE,
    topK: optionalIntOption(request.searchOptions, TOP_K) ?? DEFAULT_TOP_K,
  };

  const embedding =
    model.kind === 'vertexAi'
      ? await embedContent(model.modelName, request.query, outputDimensionality)
      : await embedInSpanner(
          database,
          model,
          request.query,
          outputDimensionality,
        );

  const sql =
    algorithm === EXACT_NEAREST_NEIGHBORS
      ? generateSqlForKnn(search)
      : generateSqlForAnn(
          search,
          optionalIntOption(request.searchOptions, NUM_LEAVES_TO_SEARCH) ??
            DEFAULT_NUM_LEAVES_TO_SEARCH,
        );

  const params =
    dialect === POSTGRESQL_DIALECT
      ? {['p1']: embedding}
      : {[GOOGLESQL_EMBEDDING_PARAMETER]: embedding};
  const rows = await withSnapshot(database, (snapshot) =>
    selectValueRows(snapshot, {sql, params}),
  );
  return {rows: rows.map(toJsonSafe)};
}

const similaritySearchParams = z.object({
  project_id: z
    .string()
    .describe('The GCP project id in which the Spanner database resides.'),
  instance_id: z.string().describe('The Spanner instance id.'),
  database_id: z.string().describe('The Spanner database id.'),
  table_name: z.string().describe('The table to search.'),
  query: z
    .string()
    .describe('The text to embed and find the most similar rows for.'),
  embedding_column_to_search: z
    .string()
    .describe('The column holding the embeddings to compare against.'),
  columns: z
    .array(z.string())
    .describe('The columns to return alongside the distance.'),
  embedding_options: z
    .record(z.string(), z.unknown())
    .describe(
      'Exactly one of "vertex_ai_embedding_model_name" (a public Vertex AI' +
        ' model, embedded on the client, either dialect),' +
        ' "spanner_googlesql_embedding_model_name" (a model registered in a' +
        ' GoogleSQL database, embedded by ML.PREDICT) or' +
        ' "spanner_postgresql_vertex_ai_embedding_model_endpoint" (a' +
        ' projects/$p/locations/$l/publishers/$pub/models/$m endpoint, embedded' +
        ' by spanner.ML_PREDICT_ROW). May also carry' +
        ' "output_dimensionality", which the GoogleSQL model does not accept.',
    ),
  additional_filter: z
    .string()
    .optional()
    .describe(
      'An extra WHERE condition. Columns compared with =, !=, <, >, <=, >=,' +
        ' LIKE, IS, IS NOT, IN, NOT IN or BETWEEN, joined by AND or OR, with' +
        ' up to 2 levels of parentheses. Values must be numbers,' +
        ' single-quoted strings without backslashes, booleans or NULL.',
    ),
  search_options: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'May carry "top_k" (default 4), "distance_type" (COSINE, EUCLIDEAN or' +
        ' DOT_PRODUCT, default COSINE), "nearest_neighbors_algorithm"' +
        ' (EXACT_NEAREST_NEIGHBORS or APPROXIMATE_NEAREST_NEIGHBORS, default' +
        ' exact) and "num_leaves_to_search" (approximate search only).',
    ),
});

/** Searches any table that holds an embedding column. */
export const similaritySearchTool: SpannerToolDefinition<
  typeof similaritySearchParams
> = {
  name: 'similarity_search',
  description:
    'Find the rows of a Spanner table whose embedding column is closest to a' +
    ' text query. The query is embedded first, then compared against the' +
    ' column. The last value of each row is the distance.',
  parameters: similaritySearchParams,
  validate(args) {
    validateIdentifier(args.table_name, 'table_name');
    validateIdentifier(
      args.embedding_column_to_search,
      'embedding_column_to_search',
    );
    validateColumnList(args.columns, 'columns');
    if (args.additional_filter) {
      validateAdditionalFilter(args.additional_filter);
    }
    const googlesql = optionalStringOption(
      args.embedding_options,
      SPANNER_GSQL_EMBEDDING_MODEL_NAME,
    );
    if (googlesql) {
      validateIdentifier(googlesql, SPANNER_GSQL_EMBEDDING_MODEL_NAME);
    }
    const endpoint = optionalStringOption(
      args.embedding_options,
      SPANNER_PG_VERTEX_AI_EMBEDDING_MODEL_ENDPOINT,
    );
    if (endpoint) {
      validateVertexAiEndpoint(endpoint);
    }
  },
  target: (args) => ({
    projectId: args.project_id,
    instanceId: args.instance_id,
    databaseId: args.database_id,
  }),
  run: (call, args) =>
    similaritySearch(call, {
      tableName: args.table_name,
      query: args.query,
      embeddingColumnToSearch: args.embedding_column_to_search,
      columns: args.columns,
      embeddingOptions: args.embedding_options,
      additionalFilter: args.additional_filter,
      searchOptions: args.search_options ?? {},
    }),
};

const vectorStoreSimilaritySearchParams = z.object({
  query: z
    .string()
    .describe('The search string, based on the user\u2019s question.'),
});

/**
 * Reads the vector store the settings configure.
 *
 * @throws Error if the settings name no vector store, or if the vector store
 *   they name is not usable.
 */
function requireVectorStore(settings: SpannerToolSettings) {
  if (!settings.vectorStoreSettings) {
    throw new Error('Spanner vector store settings are not set.');
  }
  return resolveVectorStoreSettings(settings.vectorStoreSettings);
}

/**
 * Builds the `spanner_vector_store_similarity_search` tool, which searches
 * the one table the settings configure and takes only the query text.
 *
 * @param settings The Spanner tool settings, which must carry a vector store.
 * @return The tool definition.
 */
export function getVectorStoreSimilaritySearchTool(
  settings: SpannerToolSettings,
): SpannerToolDefinition<typeof vectorStoreSimilaritySearchParams> {
  return {
    name: 'vector_store_similarity_search',
    description:
      'Retrieve the context most relevant to a question from the Spanner' +
      ' vector store this agent is configured with. The last value of each' +
      ' row is the distance.',
    parameters: vectorStoreSimilaritySearchParams,
    target() {
      const store = requireVectorStore(settings);
      return {
        projectId: store.projectId,
        instanceId: store.instanceId,
        databaseId: store.databaseId,
      };
    },
    run(call, args) {
      const store = requireVectorStore(settings);
      const searchOptions: ToolOptions = {
        [TOP_K]: store.topK,
        [DISTANCE_TYPE]: store.distanceType,
        [NEAREST_NEIGHBORS_ALGORITHM]: store.nearestNeighborsAlgorithm,
      };
      if (store.nearestNeighborsAlgorithm === APPROXIMATE_NEAREST_NEIGHBORS) {
        searchOptions[NUM_LEAVES_TO_SEARCH] = store.numLeavesToSearch;
      }
      return similaritySearch(call, {
        tableName: store.tableName,
        query: args.query,
        embeddingColumnToSearch: store.embeddingColumn,
        columns: store.selectedColumns,
        embeddingOptions: {
          [VERTEX_AI_EMBEDDING_MODEL_NAME]: store.vertexAiEmbeddingModelName,
          [OUTPUT_DIMENSIONALITY]: store.vectorLength,
        },
        additionalFilter: store.additionalFilter,
        searchOptions,
      });
    },
  };
}
