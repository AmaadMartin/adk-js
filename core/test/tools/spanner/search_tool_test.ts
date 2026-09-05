/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  SpannerToolSettings,
  SpannerToolset,
  SpannerVectorStoreSettings,
} from '@google/adk/tools/spanner';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {getVectorStoreSimilaritySearchTool} from '../../../src/tools/spanner/search_tool.js';
import {
  errorOf,
  runTool,
  spannerFake,
  successOf,
  testCredentialsConfig,
  valueRow,
} from './spanner_test_utils.js';

vi.mock('@google-cloud/spanner', async () => {
  const {fakeSpannerModule} = await import('./spanner_test_utils.js');
  return fakeSpannerModule;
});

const genai = vi.hoisted(() => ({embedContent: vi.fn()}));

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  class GoogleGenAI {
    readonly models = {embedContent: genai.embedContent};
  }
  return {...actual, GoogleGenAI};
});

const VERTEX_AI_EMBEDDING = [0.1, 0.2, 0.3];

const SEARCH_ARGS = {
  project_id: 'p',
  instance_id: 'i',
  database_id: 'd',
  table_name: 'documents',
  query: 'cleaning tools',
  embedding_column_to_search: 'embedding',
  columns: ['content'],
  embedding_options: {vertex_ai_embedding_model_name: 'text-embedding-005'},
};

const VECTOR_STORE: SpannerVectorStoreSettings = {
  projectId: 'vp',
  instanceId: 'vi',
  databaseId: 'vd',
  tableName: 'store',
  contentColumn: 'content',
  embeddingColumn: 'embedding',
  vectorLength: 768,
  vertexAiEmbeddingModelName: 'text-embedding-005',
};

function toolset(settings?: SpannerToolSettings): SpannerToolset {
  return new SpannerToolset({
    credentialsConfig: testCredentialsConfig(),
    spannerToolSettings: settings,
  });
}

async function search(
  overrides: Record<string, unknown> = {},
): Promise<unknown> {
  return runTool(toolset(), 'spanner_similarity_search', {
    ...SEARCH_ARGS,
    ...overrides,
  });
}

/** The statement of the last query, with its whitespace collapsed. */
function lastSql(): string {
  return spannerFake.lastQuery().sql.replace(/\s+/g, ' ').trim();
}

describe('spanner_similarity_search', () => {
  beforeEach(() => {
    spannerFake.reset();
    genai.embedContent.mockReset();
    genai.embedContent.mockResolvedValue({
      embeddings: [{values: VERTEX_AI_EMBEDDING}],
    });
  });

  describe('the exact nearest neighbour search', () => {
    it('orders a GoogleSQL table by cosine distance', async () => {
      spannerFake.responses = [
        {match: 'COSINE_DISTANCE', rows: [valueRow('a mop', 0.31)]},
      ];

      const result = await search();

      expect(successOf(result)['rows']).toEqual([['a mop', 0.31]]);
      expect(lastSql()).toBe(
        'SELECT content, COSINE_DISTANCE( embedding, @embedding) AS distance' +
          ' FROM documents WHERE 1=1 ORDER BY distance LIMIT 4',
      );
      expect(spannerFake.lastQuery().params).toEqual({
        embedding: VERTEX_AI_EMBEDDING,
      });
    });

    it('orders a PostgreSQL table with the spanner distance function', async () => {
      spannerFake.dialect = 'POSTGRESQL';

      await search();

      expect(lastSql()).toBe(
        'SELECT content, spanner.cosine_distance( embedding, $1) AS distance' +
          ' FROM documents WHERE 1=1 ORDER BY distance LIMIT 4',
      );
      expect(spannerFake.lastQuery().params).toEqual({
        p1: VERTEX_AI_EMBEDDING,
      });
    });

    it('applies the additional filter instead of the dummy one', async () => {
      await search({additional_filter: 'price_in_cents < 100000'});

      expect(lastSql()).toContain('WHERE price_in_cents < 100000');
    });

    it.each([
      ['EUCLIDEAN', 'EUCLIDEAN_DISTANCE'],
      ['DOT_PRODUCT', 'DOT_PRODUCT'],
    ])('uses the %s distance function', async (distanceType, fn) => {
      await search({search_options: {distance_type: distanceType}});

      expect(lastSql()).toContain(`${fn}(`);
    });

    it('omits the limit when top_k is not positive', async () => {
      await search({search_options: {top_k: 0}});

      expect(lastSql()).not.toContain('LIMIT');
    });

    it('accepts the numeric strings a model tends to emit', async () => {
      await search({search_options: {top_k: '7'}});

      expect(lastSql()).toContain('LIMIT 7');
    });

    it('returns every column the call asked for', async () => {
      await search({columns: ['title', 'body']});

      expect(lastSql()).toContain('SELECT title, body, COSINE_DISTANCE(');
    });
  });

  describe('the approximate nearest neighbour search', () => {
    const ANN = {
      search_options: {
        nearest_neighbors_algorithm: 'APPROXIMATE_NEAREST_NEIGHBORS',
      },
    };

    it('reads the vector index and defaults to 1000 leaves', async () => {
      await search(ANN);

      expect(lastSql()).toBe(
        'SELECT content, APPROX_COSINE_DISTANCE( embedding, @embedding,' +
          ' options => JSON \'{"num_leaves_to_search": 1000}\' ) AS distance' +
          ' FROM documents WHERE embedding IS NOT NULL ORDER BY distance' +
          ' LIMIT 4',
      );
    });

    it('searches the number of leaves the call asks for', async () => {
      await search({
        search_options: {...ANN.search_options, num_leaves_to_search: 50},
      });

      expect(lastSql()).toContain('"num_leaves_to_search": 50');
    });

    it('conjoins the additional filter with the not-null check', async () => {
      await search({...ANN, additional_filter: "category IN ('books')"});

      expect(lastSql()).toContain(
        "WHERE embedding IS NOT NULL AND category IN ('books')",
      );
    });

    it('keeps the limit even when top_k is not positive', async () => {
      await search({
        search_options: {...ANN.search_options, top_k: 0},
      });

      expect(lastSql()).toContain('LIMIT 0');
    });

    it('refuses a PostgreSQL database', async () => {
      spannerFake.dialect = 'POSTGRESQL';

      expect(errorOf(await search(ANN))).toBe(
        'APPROXIMATE_NEAREST_NEIGHBORS is not supported for PostgreSQL' +
          ' dialect.',
      );
    });

    it('refuses an algorithm Spanner does not offer', async () => {
      const result = await search({
        search_options: {nearest_neighbors_algorithm: 'FUZZY'},
      });

      expect(errorOf(result)).toBe(
        "Unsupported search_options['nearest_neighbors_algorithm']: FUZZY",
      );
    });
  });

  describe('the embedding model', () => {
    it('embeds on the client with a Vertex AI model', async () => {
      await search();

      expect(genai.embedContent).toHaveBeenCalledWith({
        model: 'text-embedding-005',
        contents: ['cleaning tools'],
        config: {},
      });
      expect(spannerFake.queries).toHaveLength(1);
    });

    it('asks Vertex AI for the output dimensionality when one is given', async () => {
      await search({
        embedding_options: {...SEARCH_ARGS.embedding_options},
      });
      genai.embedContent.mockClear();

      await search({
        embedding_options: {
          vertex_ai_embedding_model_name: 'text-embedding-005',
          output_dimensionality: '256',
        },
      });

      expect(genai.embedContent).toHaveBeenCalledWith(
        expect.objectContaining({config: {outputDimensionality: 256}}),
      );
    });

    it('reports a Vertex AI failure as an error', async () => {
      genai.embedContent.mockRejectedValue(new Error('quota exceeded'));

      expect(errorOf(await search())).toContain(
        'Failed to embed content: quota exceeded',
      );
    });

    it('reports an empty Vertex AI response as an error', async () => {
      genai.embedContent.mockResolvedValue({embeddings: []});

      expect(errorOf(await search())).toContain(
        'the response carried no embedding.',
      );
    });

    it('embeds inside a GoogleSQL database with ML.PREDICT', async () => {
      spannerFake.responses = [
        {match: 'ML.PREDICT', rows: [valueRow([0.5, 0.6])]},
      ];

      await search({
        embedding_options: {
          spanner_googlesql_embedding_model_name: 'EmbeddingsModel',
        },
      });

      expect(genai.embedContent).not.toHaveBeenCalled();
      expect(spannerFake.queries[0].sql).toContain('MODEL EmbeddingsModel');
      expect(spannerFake.queries[0].params).toEqual({
        query: 'cleaning tools',
      });
      expect(spannerFake.lastQuery().params).toEqual({embedding: [0.5, 0.6]});
    });

    it('embeds inside a PostgreSQL database with ML_PREDICT_ROW', async () => {
      spannerFake.dialect = 'POSTGRESQL';
      spannerFake.responses = [
        {match: 'ML_PREDICT_ROW', rows: [valueRow([0.7])]},
      ];

      await search({
        embedding_options: {
          spanner_postgresql_vertex_ai_embedding_model_endpoint:
            'projects/p/locations/us-central1/publishers/google/models/text-embedding-005',
        },
      });

      const embeddingSql = spannerFake.queries[0].sql;
      expect(embeddingSql).toContain(
        "'projects/p/locations/us-central1/publishers/google/models/text-embedding-005'",
      );
      expect(embeddingSql).not.toContain('outputDimensionality');
      expect(spannerFake.queries[0].params).toEqual({p1: 'cleaning tools'});
      expect(spannerFake.lastQuery().params).toEqual({p1: [0.7]});
    });

    it('asks a PostgreSQL model for the output dimensionality', async () => {
      spannerFake.dialect = 'POSTGRESQL';

      await search({
        embedding_options: {
          spanner_postgresql_vertex_ai_embedding_model_endpoint:
            'projects/p/locations/l/publishers/google/models/m',
          output_dimensionality: 128,
        },
      });

      expect(spannerFake.queries[0].sql).toContain("'outputDimensionality'");
      expect(spannerFake.queries[0].sql).toContain('128');
    });

    it.each([
      ['no model', {}],
      [
        'two models',
        {
          vertex_ai_embedding_model_name: 'm',
          spanner_googlesql_embedding_model_name: 'g',
        },
      ],
      [
        'three models',
        {
          vertex_ai_embedding_model_name: 'm',
          spanner_googlesql_embedding_model_name: 'g',
          spanner_postgresql_vertex_ai_embedding_model_endpoint:
            'projects/p/locations/l/publishers/google/models/m',
        },
      ],
    ])('refuses embedding options naming %s', async (_case, options) => {
      const result = await search({embedding_options: options});

      expect(errorOf(result)).toBe(
        'Exactly one embedding model option must be specified.',
      );
    });

    it('refuses a PostgreSQL endpoint against a GoogleSQL database', async () => {
      const result = await search({
        embedding_options: {
          spanner_postgresql_vertex_ai_embedding_model_endpoint:
            'projects/p/locations/l/publishers/google/models/m',
        },
      });

      expect(errorOf(result)).toBe(
        "embedding_options['vertex_ai_embedding_model_name'] or" +
          " embedding_options['spanner_googlesql_embedding_model_name'] must" +
          ' be specified for GoogleSQL dialect Spanner database.',
      );
    });

    it('refuses a GoogleSQL model against a PostgreSQL database', async () => {
      spannerFake.dialect = 'POSTGRESQL';

      const result = await search({
        embedding_options: {spanner_googlesql_embedding_model_name: 'M'},
      });

      expect(errorOf(result)).toBe(
        "embedding_options['vertex_ai_embedding_model_name'] or" +
          " embedding_options['spanner_postgresql_vertex_ai_embedding_model_endpoint']" +
          ' must be specified for PostgreSQL dialect Spanner database.',
      );
    });

    it('refuses an output dimensionality ML.PREDICT cannot honour', async () => {
      const result = await search({
        embedding_options: {
          spanner_googlesql_embedding_model_name: 'M',
          output_dimensionality: 128,
        },
      });

      expect(errorOf(result)).toBe(
        'embedding_options[output_dimensionality] is not supported when' +
          " embedding_options['spanner_googlesql_embedding_model_name'] is" +
          ' specified.',
      );
    });

    it('refuses an option that is not the type it must be', async () => {
      const result = await search({
        search_options: {distance_type: 5},
      });

      expect(errorOf(result)).toBe(
        "Option 'distance_type' must be a string, got 5.",
      );
    });

    it.each([['not-a-number'], [1.5], ['']])(
      'refuses top_k of %j',
      async (topK) => {
        const result = await search({search_options: {top_k: topK}});

        expect(errorOf(result)).toContain("Option 'top_k' must be an integer");
      },
    );

    it('ignores an option explicitly set to null', async () => {
      await search({search_options: {top_k: null, distance_type: null}});

      expect(lastSql()).toContain('COSINE_DISTANCE');
      expect(lastSql()).toContain('LIMIT 4');
    });
  });

  describe('the argument checks', () => {
    it.each([
      ['table_name', {table_name: 'documents JOIN secrets s ON TRUE'}],
      ['embedding_column_to_search', {embedding_column_to_search: 'a; DROP'}],
      ['columns', {columns: ['content', '(SELECT 1)']}],
    ])(
      'refuses an unsafe %s before opening a client',
      async (parameter, overrides) => {
        const result = await search(overrides);

        expect(errorOf(result)).toContain(
          `Invalid SQL identifier for ${parameter}`,
        );
        expect(spannerFake.clientOptions).toHaveLength(0);
      },
    );

    it('refuses an unsafe additional filter', async () => {
      const result = await search({
        additional_filter: '1=1 UNION ALL SELECT password FROM admin',
      });

      expect(errorOf(result)).toContain(
        'additional_filter contains unsafe or unsupported patterns',
      );
      expect(spannerFake.clientOptions).toHaveLength(0);
    });

    it('refuses an unsafe GoogleSQL embedding model name', async () => {
      const result = await search({
        embedding_options: {spanner_googlesql_embedding_model_name: 'a; DROP'},
      });

      expect(errorOf(result)).toContain(
        'Invalid SQL identifier for spanner_googlesql_embedding_model_name',
      );
    });

    it('refuses a malformed Vertex AI endpoint', async () => {
      const result = await search({
        embedding_options: {
          spanner_postgresql_vertex_ai_embedding_model_endpoint:
            'not/an/endpoint',
        },
      });

      expect(errorOf(result)).toContain('Invalid Vertex AI endpoint format');
    });

    it('refuses a dialect the tools do not know', async () => {
      spannerFake.dialect = undefined;

      expect(errorOf(await search())).toBe(
        'Unsupported database dialect: undefined',
      );
    });

    it('refuses a distance type Spanner does not offer', async () => {
      const result = await search({
        search_options: {distance_type: 'MANHATTAN'},
      });

      expect(errorOf(result)).toBe('Unsupported distance_type: MANHATTAN');
    });
  });
});

describe('spanner_vector_store_similarity_search', () => {
  beforeEach(() => {
    spannerFake.reset();
    genai.embedContent.mockReset();
    genai.embedContent.mockResolvedValue({
      embeddings: [{values: VERTEX_AI_EMBEDDING}],
    });
  });

  async function vectorStoreSearch(
    overrides: Partial<SpannerVectorStoreSettings> = {},
  ): Promise<unknown> {
    return runTool(
      toolset({vectorStoreSettings: {...VECTOR_STORE, ...overrides}}),
      'spanner_vector_store_similarity_search',
      {query: 'how do I tune Spanner'},
    );
  }

  it('searches the configured table and returns its content column', async () => {
    spannerFake.responses = [
      {match: 'COSINE_DISTANCE', rows: [valueRow('tune it', 0.12)]},
    ];

    const result = await vectorStoreSearch();

    expect(successOf(result)['rows']).toEqual([['tune it', 0.12]]);
    expect(lastSql()).toBe(
      'SELECT content, COSINE_DISTANCE( embedding, @embedding) AS distance' +
        ' FROM store WHERE 1=1 ORDER BY distance LIMIT 4',
    );
    expect(spannerFake.databases).toEqual([
      {instanceId: 'vi', databaseId: 'vd', databaseRole: undefined},
    ]);
  });

  it('embeds at the configured vector length', async () => {
    await vectorStoreSearch();

    expect(genai.embedContent).toHaveBeenCalledWith({
      model: 'text-embedding-005',
      contents: ['how do I tune Spanner'],
      config: {outputDimensionality: 768},
    });
  });

  it('returns the columns the settings select', async () => {
    await vectorStoreSearch({selectedColumns: ['title', 'content']});

    expect(lastSql()).toContain('SELECT title, content, COSINE_DISTANCE(');
  });

  it('applies the configured search options', async () => {
    await vectorStoreSearch({
      topK: 2,
      distanceType: 'EUCLIDEAN',
      additionalFilter: 'is_public',
    });

    expect(lastSql()).toBe(
      'SELECT content, EUCLIDEAN_DISTANCE( embedding, @embedding) AS distance' +
        ' FROM store WHERE is_public ORDER BY distance LIMIT 2',
    );
  });

  it('passes the leaves to search only for an approximate search', async () => {
    await vectorStoreSearch({
      nearestNeighborsAlgorithm: 'APPROXIMATE_NEAREST_NEIGHBORS',
      numLeavesToSearch: 25,
    });

    expect(lastSql()).toContain('"num_leaves_to_search": 25');
  });

  it('defaults the leaves to search for an approximate search', async () => {
    await vectorStoreSearch({
      nearestNeighborsAlgorithm: 'APPROXIMATE_NEAREST_NEIGHBORS',
    });

    expect(lastSql()).toContain('"num_leaves_to_search": 1000');
  });

  it('ignores the leaves to search for an exact search', async () => {
    await vectorStoreSearch({numLeavesToSearch: 25});

    expect(lastSql()).not.toContain('num_leaves_to_search');
  });

  it('refuses to run when the settings name no vector store', () => {
    // The toolset withholds this tool unless a vector store is configured, so
    // only a direct call reaches the check.
    const definition = getVectorStoreSimilaritySearchTool({});

    expect(() => definition.target({query: 'anything'})).toThrow(
      'Spanner vector store settings are not set.',
    );
  });
});
